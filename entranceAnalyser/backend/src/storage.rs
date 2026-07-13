/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Postgres persistence for kept bboxes and their downstream analyses.
//!
//! Two concerns live here:
//!
//! * `kept_bboxes` — one row per Keep decision, with a PostGIS polygon
//!   geometry alongside the raw coordinates so spatial queries work
//!   out of the box.
//! * `analyses` — generic key/value side-table keyed by `(bbox_id, kind)`.
//!   `record_analysis` is the generic upsert; the typed helpers below
//!   handle the two analysis steps end to end:
//!   - `kind='poi_pick'` (`get_kept`, `read_poi_pick`, `read_all_poi_picks`,
//!     `write_poi_pick`, `set_poi_pick_completed`, `set_poi_pick_rejection`)
//!     — picks one POI per cell. The reviewer can flip the row to one of
//!     three terminal states: pending (default), completed, or rejected
//!     with a reason; `completed` and `rejected` are mutually exclusive.
//!   - `kind='poi_focus'` (`read_poi_focus`, `read_all_poi_focuses`,
//!     `write_poi_focus`) — caches the buildings + entrances around the
//!     picked POI.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::types::Json as SqlxJson;
use sqlx::PgPool;
use uuid::Uuid;

use crate::bbox::{Bbox, CandidateSource, KeptBbox};
use crate::focus_measurements::{
    EntranceKind, MeasurementDeltaAggregate, MeasurementFourNumberStats,
    MeasurementPairAggregate, MeasurementPurpose, MeasurementStartOrigin, PoiFocusMeasurement,
    PoiFocusMeasurementStats,
};
use crate::measurement_destination_warnings::{
    destination_warnings_by_bbox, main_vs_centroid_endpoint_agreement,
    PoiFocusMeasurementDestinationWarningsResponse,
};
use crate::overpass::Poi;
use crate::poi_focus::PoiFocusResult;

/// Discriminator stored in `analyses.kind` for the POI-pick step.
const POI_PICK_KIND: &str = "poi_pick";

/// Discriminator stored in `analyses.kind` for the POI-focus step.
const POI_FOCUS_KIND: &str = "poi_focus";

/// Thin, clone-friendly handle over the shared Postgres pool.
#[derive(Debug, Clone)]
pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Persist a bbox as kept. Returns the total number of kept bboxes
    /// after the insert so the HTTP handler can echo that count back to
    /// the UI in one round-trip.
    pub async fn append(&self, bbox: Bbox) -> Result<i64, sqlx::Error> {
        let polygon_wkt = polygon_wkt(&bbox);
        sqlx::query(
            "INSERT INTO kept_bboxes (id, west, south, east, north, \
                                      center_lon, center_lat, cell_size_km, \
                                      population, density_per_km2, max_density_ratio, \
                                      built_volume, max_built_volume_ratio, \
                                      candidate_source, custom_osm_type, custom_osm_id, geom) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, \
                     ST_GeomFromText($17, 4326))",
        )
        .bind(bbox.id)
        .bind(bbox.west)
        .bind(bbox.south)
        .bind(bbox.east)
        .bind(bbox.north)
        .bind(bbox.center[0])
        .bind(bbox.center[1])
        .bind(bbox.cell_size_km as i32)
        .bind(bbox.population)
        .bind(bbox.density_per_km2)
        .bind(bbox.max_density_ratio)
        .bind(bbox.built_volume)
        .bind(bbox.max_built_volume_ratio)
        .bind(bbox.candidate_source.as_str())
        .bind(bbox.custom_osm_type.as_deref())
        .bind(bbox.custom_osm_id)
        .bind(polygon_wkt)
        .execute(&self.pool)
        .await?;
        self.count().await
    }

    /// All kept bboxes, ordered by insertion time (oldest first) so the
    /// UI can render a stable chronological list.
    pub async fn load(&self) -> Result<Vec<KeptBbox>, sqlx::Error> {
        let rows: Vec<KeptRow> = sqlx::query_as::<_, KeptRow>(
            "SELECT id, west, south, east, north, center_lon, center_lat, \
                    cell_size_km, population, density_per_km2, max_density_ratio, \
                    built_volume, max_built_volume_ratio, candidate_source, \
                    custom_osm_type, custom_osm_id, kept_at \
             FROM kept_bboxes ORDER BY kept_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(KeptRow::into_kept).collect())
    }

    /// Number of rows in `kept_bboxes`.
    pub async fn count(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM kept_bboxes")
            .fetch_one(&self.pool)
            .await
    }

    /// Upsert a per-bbox analysis record. Re-recording the same
    /// `(bbox_id, kind)` pair replaces the previous value, which is the
    /// behaviour most analysis pipelines want when they re-run.
    pub async fn record_analysis(
        &self,
        bbox_id: Uuid,
        kind: &str,
        value: Option<f64>,
        payload: Option<JsonValue>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO analyses (bbox_id, kind, value, payload) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (bbox_id, kind) DO UPDATE \
             SET value = EXCLUDED.value, payload = EXCLUDED.payload, created_at = now()",
        )
        .bind(bbox_id)
        .bind(kind)
        .bind(value)
        .bind(payload)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Look up one kept bbox by id. The HTTP handler needs the bbox
    /// coordinates to bound the Overpass query, so this returns the
    /// full record rather than just an existence flag.
    pub async fn get_kept(&self, id: Uuid) -> Result<Option<KeptBbox>, sqlx::Error> {
        let row: Option<KeptRow> = sqlx::query_as::<_, KeptRow>(
            "SELECT id, west, south, east, north, center_lon, center_lat, \
                    cell_size_km, population, density_per_km2, max_density_ratio, \
                    built_volume, max_built_volume_ratio, candidate_source, \
                    custom_osm_type, custom_osm_id, kept_at \
             FROM kept_bboxes WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(KeptRow::into_kept))
    }

    /// Remove one kept bbox row. `analyses` and `poi_focus_measurements`
    /// rows for the same `bbox_id` cascade automatically (FK `ON DELETE
    /// CASCADE`). Returns whether a row was deleted.
    pub async fn remove_kept(&self, id: Uuid) -> Result<bool, sqlx::Error> {
        let res = sqlx::query("DELETE FROM kept_bboxes WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Read the cached POI pick for `bbox_id`, if any.
    ///
    /// * `Ok(None)` — no `poi_pick` row yet (caller must run Overpass).
    /// * `Ok(Some(None))` — analysis ran but no POI matched (cached null).
    /// * `Ok(Some(Some(poi)))` — a POI was previously picked and cached.
    pub async fn read_poi_pick(&self, bbox_id: Uuid) -> Result<Option<Option<Poi>>, sqlx::Error> {
        Ok(self
            .read_poi_pick_payload(bbox_id)
            .await?
            .map(|p| p.poi))
    }

    /// Full `poi_pick` payload (POI + reviewer "completed" flag). Used by
    /// HTTP handlers that must echo `completed` and by PATCH updates.
    pub async fn read_poi_pick_payload(
        &self,
        bbox_id: Uuid,
    ) -> Result<Option<PoiPickPayload>, sqlx::Error> {
        let row: Option<SqlxJson<PoiPickPayload>> =
            sqlx::query_scalar("SELECT payload FROM analyses WHERE bbox_id = $1 AND kind = $2")
                .bind(bbox_id)
                .bind(POI_PICK_KIND)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|j| j.0))
    }

    /// Every cached POI pick, paired with its bbox id, ordered by
    /// insertion time so the UI gets a chronological list. Used by the
    /// frontend on map load to render which kept cells already have a
    /// pick.
    pub async fn read_all_poi_picks(&self) -> Result<Vec<(Uuid, PoiPickPayload)>, sqlx::Error> {
        let rows: Vec<(Uuid, SqlxJson<PoiPickPayload>)> = sqlx::query_as(
            "SELECT bbox_id, payload FROM analyses \
             WHERE kind = $1 ORDER BY created_at ASC, bbox_id ASC",
        )
        .bind(POI_PICK_KIND)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id, j)| (id, j.0)).collect())
    }

    /// Persist (or replace) the POI pick for `bbox_id`. `Some(poi)`
    /// records the picked feature; `None` records a cached "no POI in
    /// this cell" verdict so the next request short-circuits without
    /// hitting Overpass.
    pub async fn write_poi_pick(
        &self,
        bbox_id: Uuid,
        poi: Option<&Poi>,
    ) -> Result<(), sqlx::Error> {
        // A fresh Overpass pick clears any prior reviewer state (the row
        // may be re-rolled, so completed/rejected from the old POI no
        // longer applies).
        let payload = SqlxJson(PoiPickPayload {
            poi: poi.cloned(),
            completed: false,
            rejected: false,
            rejected_reason: None,
        });
        sqlx::query(
            "INSERT INTO analyses (bbox_id, kind, value, payload) \
             VALUES ($1, $2, NULL, $3) \
             ON CONFLICT (bbox_id, kind) DO UPDATE \
             SET value = NULL, payload = EXCLUDED.payload, created_at = now()",
        )
        .bind(bbox_id)
        .bind(POI_PICK_KIND)
        .bind(payload)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Set the reviewer "completed" flag on an existing `poi_pick` row.
    /// Returns `Ok(None)` when no row exists. Preserves `poi`; does not
    /// create a row. Setting `completed = true` clears any prior
    /// rejection state so the row stays in a single, well-defined
    /// terminal state; setting `completed = false` simply unflags.
    pub async fn set_poi_pick_completed(
        &self,
        bbox_id: Uuid,
        completed: bool,
    ) -> Result<Option<PoiPickPayload>, sqlx::Error> {
        let Some(mut payload) = self.read_poi_pick_payload(bbox_id).await? else {
            return Ok(None);
        };
        payload.completed = completed;
        if completed {
            payload.rejected = false;
            payload.rejected_reason = None;
        }
        self.write_poi_pick_payload(bbox_id, &payload).await?;
        Ok(Some(payload))
    }

    /// Set or clear the reviewer rejection on an existing `poi_pick`
    /// row. `Some(reason)` flags the POI as rejected (clearing any
    /// `completed` flag); `None` clears the rejection (and leaves
    /// `completed` untouched, so the row simply returns to "pending").
    /// Returns `Ok(None)` when no row exists. Preserves `poi`; does
    /// not create a row.
    pub async fn set_poi_pick_rejection(
        &self,
        bbox_id: Uuid,
        reason: Option<PoiRejectionReason>,
    ) -> Result<Option<PoiPickPayload>, sqlx::Error> {
        let Some(mut payload) = self.read_poi_pick_payload(bbox_id).await? else {
            return Ok(None);
        };
        match reason {
            Some(r) => {
                payload.rejected = true;
                payload.rejected_reason = Some(r);
                payload.completed = false;
            }
            None => {
                payload.rejected = false;
                payload.rejected_reason = None;
            }
        }
        self.write_poi_pick_payload(bbox_id, &payload).await?;
        Ok(Some(payload))
    }

    /// Shared write path used by `set_poi_pick_completed` and
    /// `set_poi_pick_rejection`. Bumps `created_at` so the UI's
    /// "most-recent-first" ordering still reflects reviewer activity.
    async fn write_poi_pick_payload(
        &self,
        bbox_id: Uuid,
        payload: &PoiPickPayload,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE analyses SET payload = $1, created_at = now() \
             WHERE bbox_id = $2 AND kind = $3",
        )
        .bind(SqlxJson(payload.clone()))
        .bind(bbox_id)
        .bind(POI_PICK_KIND)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read the cached POI-focus result for `bbox_id`, if any.
    ///
    /// Returns `Ok(None)` when no `poi_focus` row exists yet (caller
    /// must run Overpass). Unlike `read_poi_pick`, the result is
    /// always populated when the row exists — empty surroundings are
    /// represented by empty `FeatureCollection`s, not by a missing
    /// row.
    pub async fn read_poi_focus(
        &self,
        bbox_id: Uuid,
    ) -> Result<Option<PoiFocusResult>, sqlx::Error> {
        let row: Option<SqlxJson<PoiFocusResult>> =
            sqlx::query_scalar("SELECT payload FROM analyses WHERE bbox_id = $1 AND kind = $2")
                .bind(bbox_id)
                .bind(POI_FOCUS_KIND)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|j| j.0))
    }

    /// Every cached POI-focus result, paired with its bbox id, ordered
    /// by insertion time so the frontend can hydrate its in-memory map
    /// in chronological order on load.
    pub async fn read_all_poi_focuses(&self) -> Result<Vec<(Uuid, PoiFocusResult)>, sqlx::Error> {
        let rows: Vec<(Uuid, SqlxJson<PoiFocusResult>)> = sqlx::query_as(
            "SELECT bbox_id, payload FROM analyses \
             WHERE kind = $1 ORDER BY created_at ASC, bbox_id ASC",
        )
        .bind(POI_FOCUS_KIND)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id, j)| (id, j.0)).collect())
    }

    /// Persist (or replace) the POI-focus result for `bbox_id`. The
    /// payload always exists; "no buildings or entrances within the
    /// radius" is encoded as empty FeatureCollections, not as a
    /// missing row, so the next click short-circuits without hitting
    /// Overpass either way.
    pub async fn write_poi_focus(
        &self,
        bbox_id: Uuid,
        focus: &PoiFocusResult,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO analyses (bbox_id, kind, value, payload) \
             VALUES ($1, $2, NULL, $3) \
             ON CONFLICT (bbox_id, kind) DO UPDATE \
             SET value = NULL, payload = EXCLUDED.payload, created_at = now()",
        )
        .bind(bbox_id)
        .bind(POI_FOCUS_KIND)
        .bind(SqlxJson(focus))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Every saved measurement polyline across all kept bboxes (oldest first).
    pub async fn list_all_poi_focus_measurements(
        &self,
    ) -> Result<Vec<PoiFocusMeasurement>, sqlx::Error> {
        let rows: Vec<MeasurementRow> = sqlx::query_as(
            "SELECT id, bbox_id, coordinates, walking_speed_kmh, length_m, \
                    measurement_type, entrance_type, start_origin, start_osm_node_id, created_at \
             FROM poi_focus_measurements \
             ORDER BY bbox_id ASC, created_at ASC, id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(MeasurementRow::into_public).collect())
    }

    /// Every saved measurement polyline for one kept bbox (oldest first).
    pub async fn list_poi_focus_measurements(
        &self,
        bbox_id: Uuid,
    ) -> Result<Vec<PoiFocusMeasurement>, sqlx::Error> {
        let rows: Vec<MeasurementRow> = sqlx::query_as(
            "SELECT id, bbox_id, coordinates, walking_speed_kmh, length_m, \
                    measurement_type, entrance_type, start_origin, start_osm_node_id, created_at \
             FROM poi_focus_measurements \
             WHERE bbox_id = $1 \
             ORDER BY created_at ASC, id ASC",
        )
        .bind(bbox_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(MeasurementRow::into_public).collect())
    }

    /// Insert a measurement row. Caller must have validated coordinates and speed.
    pub async fn insert_poi_focus_measurement(
        &self,
        bbox_id: Uuid,
        coordinates: &[[f64; 2]],
        walking_speed_kmh: f64,
        length_m: i32,
        measurement_type: MeasurementPurpose,
        entrance_type: EntranceKind,
        start_origin: MeasurementStartOrigin,
        start_osm_node_id: Option<i64>,
    ) -> Result<PoiFocusMeasurement, sqlx::Error> {
        let coords = SqlxJson(coordinates.to_vec());
        let row: MeasurementRow = sqlx::query_as(
            "INSERT INTO poi_focus_measurements \
                 (bbox_id, coordinates, walking_speed_kmh, length_m, \
                  measurement_type, entrance_type, start_origin, start_osm_node_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             RETURNING id, bbox_id, coordinates, walking_speed_kmh, length_m, \
                       measurement_type, entrance_type, start_origin, start_osm_node_id, created_at",
        )
        .bind(bbox_id)
        .bind(coords)
        .bind(walking_speed_kmh)
        .bind(length_m)
        .bind(measurement_type.as_str())
        .bind(entrance_type.as_str())
        .bind(start_origin.as_str())
        .bind(start_osm_node_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.into_public())
    }

    /// Replace geometry and speed for one row; returns `None` if the id
    /// does not exist or belongs to another bbox.
    pub async fn update_poi_focus_measurement(
        &self,
        bbox_id: Uuid,
        measurement_id: Uuid,
        coordinates: &[[f64; 2]],
        walking_speed_kmh: f64,
        length_m: i32,
        measurement_type: MeasurementPurpose,
        entrance_type: EntranceKind,
        start_origin: MeasurementStartOrigin,
        start_osm_node_id: Option<i64>,
    ) -> Result<Option<PoiFocusMeasurement>, sqlx::Error> {
        let coords = SqlxJson(coordinates.to_vec());
        let row: Option<MeasurementRow> = sqlx::query_as(
            "UPDATE poi_focus_measurements \
             SET coordinates = $1, walking_speed_kmh = $2, length_m = $3, \
                 measurement_type = $4, entrance_type = $5, \
                 start_origin = $6, start_osm_node_id = $7 \
             WHERE id = $8 AND bbox_id = $9 \
             RETURNING id, bbox_id, coordinates, walking_speed_kmh, length_m, \
                       measurement_type, entrance_type, start_origin, start_osm_node_id, created_at",
        )
        .bind(coords)
        .bind(walking_speed_kmh)
        .bind(length_m)
        .bind(measurement_type.as_str())
        .bind(entrance_type.as_str())
        .bind(start_origin.as_str())
        .bind(start_osm_node_id)
        .bind(measurement_id)
        .bind(bbox_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.into_public()))
    }

    /// Delete one measurement; returns `true` if a row was removed.
    pub async fn delete_poi_focus_measurement(
        &self,
        bbox_id: Uuid,
        measurement_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let res = sqlx::query("DELETE FROM poi_focus_measurements WHERE id = $1 AND bbox_id = $2")
            .bind(measurement_id)
            .bind(bbox_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Aggregate path length (m) and walking duration (s) for every distinct
    /// pair of values among `measurement_type`, `entrance_type`, and
    /// `start_origin` (three groupings). Duration matches the frontend:
    /// `(length_m / 1000) / (walking_speed_kmh / 3600)`.
    /// `match_radius_m` is the endpoint tolerance used for the
    /// main-vs-centroid endpoint agreement counts (same knob as the
    /// destination warnings).
    pub async fn aggregate_poi_focus_measurement_pair_stats(
        &self,
        match_radius_m: f64,
    ) -> Result<PoiFocusMeasurementStats, sqlx::Error> {
        let by_measurement_type_and_entrance_type = Self::measurement_pair_bucket(
            &self.pool,
            "measurement_type",
            "entrance_type",
        )
        .await?;
        let by_measurement_type_and_start_origin = Self::measurement_pair_bucket(
            &self.pool,
            "measurement_type",
            "start_origin",
        )
        .await?;
        let by_entrance_type_and_start_origin = Self::measurement_pair_bucket(
            &self.pool,
            "entrance_type",
            "start_origin",
        )
        .await?;
        let main_entrance_vs_centroid = Self::main_entrance_vs_centroid_deltas(&self.pool).await?;
        let all = self.list_all_poi_focus_measurements().await?;
        let main_entrance_vs_centroid_endpoints =
            main_vs_centroid_endpoint_agreement(&all, match_radius_m);
        Ok(PoiFocusMeasurementStats {
            by_measurement_type_and_entrance_type,
            by_measurement_type_and_start_origin,
            by_entrance_type_and_start_origin,
            main_entrance_vs_centroid,
            main_entrance_vs_centroid_endpoints,
        })
    }

    /// Signed (centroid − main entrance) deltas per `measurement_type`:
    /// within one bbox and one measurement type, every measurement drawn
    /// from a `centroid_*` anchor is paired with every one drawn from the
    /// `main` entrance, whichever centroid kind was used. The
    /// entrance-targeting types are excluded (they measure *toward* the
    /// entrance, so the delta is meaningless there).
    async fn main_entrance_vs_centroid_deltas(
        pool: &PgPool,
    ) -> Result<Vec<MeasurementDeltaAggregate>, sqlx::Error> {
        // Same driving-type folding as the pair buckets, so a main-entrance
        // walk stored under one of the retired combo types still pairs with
        // a centroid walk stored under `to_nearest_driving_road`.
        let folded = Self::stats_bucket_expr("measurement_type");
        let rows = sqlx::query_as::<_, MeasurementDeltaAggRow>(&format!(
            "WITH mains AS ( \
                 SELECT bbox_id, {folded} AS measurement_type, \
                        length_m::float8 AS len, walking_speed_kmh \
                 FROM poi_focus_measurements WHERE entrance_type = 'main' \
             ), centroids AS ( \
                 SELECT bbox_id, {folded} AS measurement_type, \
                        length_m::float8 AS len, walking_speed_kmh \
                 FROM poi_focus_measurements WHERE entrance_type LIKE 'centroid\\_%' \
             ), deltas AS ( \
                 SELECT m.measurement_type, \
                        c.len - m.len AS dl, \
                        (c.len * 3600.0) / (1000.0 * c.walking_speed_kmh) \
                          - (m.len * 3600.0) / (1000.0 * m.walking_speed_kmh) AS ds \
                 FROM mains m \
                 JOIN centroids c USING (bbox_id, measurement_type) \
                 WHERE m.measurement_type NOT IN \
                       ('to_nearest_entrance', 'to_nearest_main_entrance') \
             ) \
             SELECT measurement_type, COUNT(*)::bigint AS n, \
                    MIN(dl) AS dl_min, MAX(dl) AS dl_max, AVG(dl) AS dl_avg, \
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY dl) AS dl_med, \
                    MIN(ds) AS ds_min, MAX(ds) AS ds_max, AVG(ds) AS ds_avg, \
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY ds) AS ds_med \
             FROM deltas GROUP BY measurement_type ORDER BY measurement_type",
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(MeasurementDeltaAggRow::into_public).collect())
    }

    /// Destination mismatch warnings for every kept bbox that has at least
    /// one warning (same endpoint rule as the focus-map UI).
    pub async fn poi_focus_measurement_destination_warnings(
        &self,
        match_radius_m: f64,
    ) -> Result<PoiFocusMeasurementDestinationWarningsResponse, sqlx::Error> {
        let measurements = self.list_all_poi_focus_measurements().await?;
        Ok(PoiFocusMeasurementDestinationWarningsResponse {
            warnings: destination_warnings_by_bbox(&measurements, match_radius_m),
        })
    }

    /// Count picked POIs per country, with a per-country "in Quebec"
    /// sub-count, by point-in-polygon against `admin_boundaries`
    /// (populated by `scripts/load_admin_boundaries.sh`). POIs matching
    /// no country polygon — or all POIs when the table is empty — land
    /// in `unresolved`.
    pub async fn aggregate_poi_pick_country_stats(
        &self,
    ) -> Result<PoiPickCountryStats, sqlx::Error> {
        let rows: Vec<PoiCountryAggRow> = sqlx::query_as(
            "WITH pois AS ( \
                 SELECT ST_SetSRID(ST_MakePoint( \
                            (payload->'poi'->'center'->>0)::float8, \
                            (payload->'poi'->'center'->>1)::float8), 4326) AS pt, \
                        COALESCE((payload->>'rejected')::boolean, false) AS rejected \
                 FROM analyses \
                 WHERE kind = $1 AND jsonb_typeof(payload->'poi') = 'object' \
             ), located AS ( \
                 SELECT p.rejected, c.iso_code, c.name, \
                        EXISTS (SELECT 1 FROM admin_boundaries q \
                                WHERE q.level = 'region' AND q.iso_code = 'CA-QC' \
                                  AND ST_Contains(q.geom, p.pt)) AS in_quebec \
                 FROM pois p \
                 LEFT JOIN admin_boundaries c \
                   ON c.level = 'country' AND ST_Contains(c.geom, p.pt) \
             ) \
             SELECT iso_code, name, COUNT(*)::bigint AS n, \
                    COUNT(*) FILTER (WHERE in_quebec)::bigint AS n_in_quebec, \
                    COUNT(*) FILTER (WHERE rejected)::bigint AS n_rejected \
             FROM located \
             GROUP BY iso_code, name \
             ORDER BY n DESC, name",
        )
        .bind(POI_PICK_KIND)
        .fetch_all(&self.pool)
        .await?;

        let total = rows.iter().map(|r| r.n).sum();
        // The NULL-country bucket (no polygon matched) becomes `unresolved`.
        let unresolved = rows
            .iter()
            .filter(|r| r.iso_code.is_none())
            .map(|r| r.n)
            .sum();
        let by_country = rows
            .into_iter()
            .filter_map(|r| {
                Some(PoiPickCountryCount {
                    iso_code: r.iso_code?,
                    name: r.name.unwrap_or_default(),
                    n: r.n,
                    n_in_quebec: r.n_in_quebec,
                    n_rejected: r.n_rejected,
                })
            })
            .collect();
        Ok(PoiPickCountryStats {
            by_country,
            total,
            unresolved,
        })
    }

    /// Stats-only folding: the two combined driving measurement types are
    /// counted as `to_nearest_driving_road` in every aggregate (their
    /// walking/cycling legs never changed the measured target, so keeping
    /// them apart only fragments the tables). Stored rows are untouched.
    fn stats_bucket_expr(col: &'static str) -> &'static str {
        if col == "measurement_type" {
            "CASE WHEN measurement_type IN \
               ('to_nearest_walking_cycling_driving_network', \
                'to_nearest_walking_driving_network') \
             THEN 'to_nearest_driving_road' ELSE measurement_type END"
        } else {
            col
        }
    }

    async fn measurement_pair_bucket(
        pool: &PgPool,
        col_a: &'static str,
        col_b: &'static str,
    ) -> Result<Vec<MeasurementPairAggregate>, sqlx::Error> {
        // `col_a` / `col_b` are fixed identifiers from Rust, not user input.
        let col_a = Self::stats_bucket_expr(col_a);
        let col_b = Self::stats_bucket_expr(col_b);
        let sql = format!(
            "SELECT {col_a} AS attr_a, {col_b} AS attr_b, \
                    COUNT(*)::bigint AS n, \
                    MIN(length_m)::float8 AS lm_min, \
                    MAX(length_m)::float8 AS lm_max, \
                    AVG(length_m)::float8 AS lm_avg, \
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY length_m::float8) AS lm_med, \
                    MIN((length_m::float8 * 3600.0) / (1000.0 * walking_speed_kmh)) AS ds_min, \
                    MAX((length_m::float8 * 3600.0) / (1000.0 * walking_speed_kmh)) AS ds_max, \
                    AVG((length_m::float8 * 3600.0) / (1000.0 * walking_speed_kmh)) AS ds_avg, \
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY \
                      (length_m::float8 * 3600.0) / (1000.0 * walking_speed_kmh)) AS ds_med \
             FROM poi_focus_measurements \
             GROUP BY {col_a}, {col_b} \
             ORDER BY {col_a}, {col_b}",
            col_a = col_a,
            col_b = col_b,
        );
        let rows = sqlx::query_as::<_, MeasurementPairAggRow>(&sql)
            .fetch_all(pool)
            .await?;
        Ok(rows.into_iter().map(MeasurementPairAggRow::into_public).collect())
    }
}

/// Row shape for `poi_focus_measurements` reads/writes.
#[derive(sqlx::FromRow)]
struct MeasurementRow {
    id: Uuid,
    bbox_id: Uuid,
    coordinates: SqlxJson<Vec<[f64; 2]>>,
    walking_speed_kmh: f64,
    length_m: i32,
    measurement_type: String,
    entrance_type: String,
    start_origin: String,
    start_osm_node_id: Option<i64>,
    created_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct MeasurementDeltaAggRow {
    measurement_type: String,
    n: i64,
    dl_min: f64,
    dl_max: f64,
    dl_avg: f64,
    dl_med: f64,
    ds_min: f64,
    ds_max: f64,
    ds_avg: f64,
    ds_med: f64,
}

impl MeasurementDeltaAggRow {
    fn into_public(self) -> MeasurementDeltaAggregate {
        MeasurementDeltaAggregate {
            measurement_type: self.measurement_type,
            n: self.n,
            delta_length_m: MeasurementFourNumberStats {
                min: self.dl_min,
                max: self.dl_max,
                avg: self.dl_avg,
                median: self.dl_med,
            },
            delta_duration_s: MeasurementFourNumberStats {
                min: self.ds_min,
                max: self.ds_max,
                avg: self.ds_avg,
                median: self.ds_med,
            },
        }
    }
}

#[derive(sqlx::FromRow)]
struct MeasurementPairAggRow {
    attr_a: String,
    attr_b: String,
    n: i64,
    lm_min: f64,
    lm_max: f64,
    lm_avg: f64,
    lm_med: f64,
    ds_min: f64,
    ds_max: f64,
    ds_avg: f64,
    ds_med: f64,
}

impl MeasurementPairAggRow {
    fn into_public(self) -> MeasurementPairAggregate {
        MeasurementPairAggregate {
            attr_a: self.attr_a,
            attr_b: self.attr_b,
            n: self.n,
            length_m: MeasurementFourNumberStats {
                min: self.lm_min,
                max: self.lm_max,
                avg: self.lm_avg,
                median: self.lm_med,
            },
            duration_s: MeasurementFourNumberStats {
                min: self.ds_min,
                max: self.ds_max,
                avg: self.ds_avg,
                median: self.ds_med,
            },
        }
    }
}

impl MeasurementRow {
    fn into_public(self) -> PoiFocusMeasurement {
        PoiFocusMeasurement {
            id: self.id,
            bbox_id: self.bbox_id,
            coordinates: self.coordinates.0,
            walking_speed_kmh: self.walking_speed_kmh,
            length_m: self.length_m,
            measurement_type: self
                .measurement_type
                .parse()
                .expect("measurement_type must satisfy DB CHECK"),
            entrance_type: self
                .entrance_type
                .parse()
                .expect("entrance_type must satisfy DB CHECK"),
            start_origin: self
                .start_origin
                .parse()
                .expect("start_origin must satisfy DB CHECK"),
            start_osm_node_id: self.start_osm_node_id,
            created_at: self.created_at,
        }
    }
}

/// Why the reviewer flagged this POI as unusable for the analysis.
///
/// Stays small on purpose: the rejection rate is computed by reason,
/// so a closed enum keeps the aggregation honest. Free-text notes are
/// out of scope for now — add a sibling field if a future analyst
/// needs them. Snake-case on the wire matches the existing
/// `candidate_source` and measurement enums.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PoiRejectionReason {
    /// Aerial and street-level imagery do not let the analyst confidently
    /// locate entrances on the site.
    NoImagery,
    /// The OSM tag is no longer accurate (e.g. a closed shop, demolished
    /// building) so the POI cannot be analysed.
    Obsolete,
    /// Catch-all for cases that do not fit `NoImagery` or `Obsolete`.
    Other,
}

/// On-disk shape of a `poi_pick` analyses payload. Keeping the wrapper
/// (rather than serialising `Poi` directly) lets us round-trip
/// "queried Overpass but matched nothing" as `{ "poi": null }`, which
/// is distinguishable from a missing row. `completed`, `rejected` and
/// `rejected_reason` all default when deserialising legacy JSON that
/// omitted them, so older rows keep loading as plain pending picks.
///
/// Invariants the writers (`set_poi_pick_completed`,
/// `set_poi_pick_rejection`) maintain and the API re-checks:
/// * `completed && rejected` is illegal (terminal states are exclusive).
/// * `rejected` requires `rejected_reason.is_some()`.
/// * `rejected_reason.is_some()` requires `rejected`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoiPickPayload {
    pub poi: Option<Poi>,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub rejected: bool,
    #[serde(default)]
    pub rejected_reason: Option<PoiRejectionReason>,
}

/// POI counts for one country, returned by
/// [`PgStore::aggregate_poi_pick_country_stats`]. `n_in_quebec` is the
/// subset of `n` that also falls inside the Quebec polygon (relevant
/// for `iso_code = "CA"`; zero elsewhere) — Quebec POIs will be treated
/// separately in future statistics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoiPickCountryCount {
    /// ISO 3166-1 alpha-2 country code from `admin_boundaries`.
    pub iso_code: String,
    pub name: String,
    pub n: i64,
    pub n_in_quebec: i64,
    /// Subset of `n` whose pick was rejected by the reviewer.
    pub n_rejected: i64,
}

/// Wire shape of `GET /api/analyses/poi_pick_country_stats`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoiPickCountryStats {
    /// Sorted by `n` descending, then country name.
    pub by_country: Vec<PoiPickCountryCount>,
    /// Every picked POI, including unresolved ones.
    pub total: i64,
    /// POIs whose center matched no country polygon (always `total`
    /// when `admin_boundaries` has not been loaded yet).
    pub unresolved: i64,
}

/// Raw grouped row for the country aggregation; `iso_code`/`name` are
/// `NULL` for POIs outside every loaded country polygon.
#[derive(sqlx::FromRow)]
struct PoiCountryAggRow {
    iso_code: Option<String>,
    name: Option<String>,
    n: i64,
    n_in_quebec: i64,
    n_rejected: i64,
}

/// Flat row shape returned by `sqlx::query_as!` — the PostGIS `geom`
/// column is derivable from the scalar columns, so we omit it on reads.
#[derive(sqlx::FromRow)]
struct KeptRow {
    id: Uuid,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    center_lon: f64,
    center_lat: f64,
    cell_size_km: i32,
    population: f64,
    density_per_km2: f64,
    max_density_ratio: f64,
    built_volume: f64,
    max_built_volume_ratio: f64,
    candidate_source: String,
    custom_osm_type: Option<String>,
    custom_osm_id: Option<i64>,
    kept_at: DateTime<Utc>,
}

impl KeptRow {
    fn into_kept(self) -> KeptBbox {
        KeptBbox {
            bbox: Bbox {
                id: self.id,
                west: self.west,
                south: self.south,
                east: self.east,
                north: self.north,
                center: [self.center_lon, self.center_lat],
                cell_size_km: self.cell_size_km as u32,
                population: self.population,
                density_per_km2: self.density_per_km2,
                max_density_ratio: self.max_density_ratio,
                built_volume: self.built_volume,
                max_built_volume_ratio: self.max_built_volume_ratio,
                candidate_source: CandidateSource::from_str(&self.candidate_source)
                    .unwrap_or(CandidateSource::Random),
                custom_osm_type: self.custom_osm_type,
                custom_osm_id: self.custom_osm_id,
            },
            kept_at: self.kept_at,
        }
    }
}

/// Format a closed rectangle WKT (`POLYGON((...))`) for the given bbox.
/// WKT uses `lon lat` ordering.
fn polygon_wkt(b: &Bbox) -> String {
    format!(
        "POLYGON(({w} {s}, {e} {s}, {e} {n}, {w} {n}, {w} {s}))",
        w = b.west,
        s = b.south,
        e = b.east,
        n = b.north,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// Legacy `poi_pick` rows persisted before the rejection feature
    /// only carry `{ poi, completed? }`. They must keep loading with
    /// the new fields defaulted, otherwise the analyst would lose
    /// every previously cached pick on deploy.
    #[test]
    fn poi_pick_payload_deserialises_legacy_rows_with_defaults() {
        // Pre-completed-flag shape (PR<8).
        let oldest: PoiPickPayload =
            serde_json::from_str(r#"{"poi":null}"#).expect("legacy null pick must parse");
        assert!(!oldest.completed);
        assert!(!oldest.rejected);
        assert!(oldest.rejected_reason.is_none());

        // Pre-rejection shape (PR8..PR13).
        let pre_reject: PoiPickPayload =
            serde_json::from_str(r#"{"poi":null,"completed":true}"#)
                .expect("pre-rejection completed pick must parse");
        assert!(pre_reject.completed);
        assert!(!pre_reject.rejected);
        assert!(pre_reject.rejected_reason.is_none());
    }

    #[test]
    fn poi_rejection_reason_serialises_to_snake_case() {
        // Wire format must stay snake_case so it matches the API
        // contract documented on PATCH /poi_pick.
        assert_eq!(
            serde_json::to_string(&PoiRejectionReason::NoImagery).unwrap(),
            r#""no_imagery""#,
        );
        assert_eq!(
            serde_json::to_string(&PoiRejectionReason::Obsolete).unwrap(),
            r#""obsolete""#,
        );
        assert_eq!(
            serde_json::to_string(&PoiRejectionReason::Other).unwrap(),
            r#""other""#,
        );
    }

    #[test]
    fn polygon_wkt_closes_the_ring() {
        let b = Bbox {
            id: Uuid::nil(),
            west: -73.6,
            south: 45.5,
            east: -73.5,
            north: 45.6,
            center: [-73.55, 45.55],
            cell_size_km: 10,
            population: 0.0,
            density_per_km2: 0.0,
            max_density_ratio: 0.0,
            built_volume: 0.0,
            max_built_volume_ratio: 0.0,
            candidate_source: CandidateSource::Random,
            custom_osm_type: None,
            custom_osm_id: None,
        };
        assert_eq!(
            polygon_wkt(&b),
            "POLYGON((-73.6 45.5, -73.5 45.5, -73.5 45.6, -73.6 45.6, -73.6 45.5))",
        );
    }
}

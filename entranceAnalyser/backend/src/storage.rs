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
//!     `write_poi_pick`, `set_poi_pick_completed`) — picks one POI per cell.
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
    EntranceKind, MeasurementPurpose, MeasurementStartOrigin, PoiFocusMeasurement,
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
        // A fresh Overpass pick clears any prior "completed" reviewer flag.
        let payload = SqlxJson(PoiPickPayload {
            poi: poi.cloned(),
            completed: false,
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
    /// create a row.
    pub async fn set_poi_pick_completed(
        &self,
        bbox_id: Uuid,
        completed: bool,
    ) -> Result<Option<PoiPickPayload>, sqlx::Error> {
        let Some(mut payload) = self.read_poi_pick_payload(bbox_id).await? else {
            return Ok(None);
        };
        payload.completed = completed;
        let bound = SqlxJson(payload.clone());
        sqlx::query(
            "UPDATE analyses SET payload = $1, created_at = now() \
             WHERE bbox_id = $2 AND kind = $3",
        )
        .bind(bound)
        .bind(bbox_id)
        .bind(POI_PICK_KIND)
        .execute(&self.pool)
        .await?;
        Ok(Some(payload))
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

/// On-disk shape of a `poi_pick` analyses payload. Keeping the wrapper
/// (rather than serialising `Poi` directly) lets us round-trip
/// "queried Overpass but matched nothing" as `{ "poi": null }`, which
/// is distinguishable from a missing row. `completed` defaults to
/// `false` when deserialising legacy JSON that omitted the field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoiPickPayload {
    pub poi: Option<Poi>,
    #[serde(default)]
    pub completed: bool,
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

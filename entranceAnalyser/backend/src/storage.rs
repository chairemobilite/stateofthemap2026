//! Postgres persistence for kept bboxes and their downstream analyses.
//!
//! Two concerns live here:
//!
//! * `kept_bboxes` — one row per Keep decision, with a PostGIS polygon
//!   geometry alongside the raw coordinates so spatial queries work
//!   out of the box.
//! * `analyses` — generic key/value side-table keyed by `(bbox_id, kind)`.
//!   `record_analysis` is the generic upsert; the typed helpers below
//!   (`get_kept`, `read_poi_pick`, `read_all_poi_picks`,
//!   `write_poi_pick`) handle the POI-pick step end to end.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::PgPool;
use sqlx::types::Json as SqlxJson;
use uuid::Uuid;

use crate::bbox::{Bbox, KeptBbox};
use crate::overpass::Poi;

/// Discriminator stored in `analyses.kind` for the POI-pick step.
const POI_PICK_KIND: &str = "poi_pick";

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
                                      geom) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, \
                     ST_GeomFromText($14, 4326))",
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
                    built_volume, max_built_volume_ratio, kept_at \
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
                    built_volume, max_built_volume_ratio, kept_at \
             FROM kept_bboxes WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(KeptRow::into_kept))
    }

    /// Read the cached POI pick for `bbox_id`, if any.
    ///
    /// * `Ok(None)` — no `poi_pick` row yet (caller must run Overpass).
    /// * `Ok(Some(None))` — analysis ran but no POI matched (cached null).
    /// * `Ok(Some(Some(poi)))` — a POI was previously picked and cached.
    pub async fn read_poi_pick(&self, bbox_id: Uuid) -> Result<Option<Option<Poi>>, sqlx::Error> {
        let row: Option<SqlxJson<PoiPickRecord>> =
            sqlx::query_scalar("SELECT payload FROM analyses WHERE bbox_id = $1 AND kind = $2")
                .bind(bbox_id)
                .bind(POI_PICK_KIND)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|j| j.0.poi))
    }

    /// Every cached POI pick, paired with its bbox id, ordered by
    /// insertion time so the UI gets a chronological list. Used by the
    /// frontend on map load to render which kept cells already have a
    /// pick.
    pub async fn read_all_poi_picks(&self) -> Result<Vec<(Uuid, Option<Poi>)>, sqlx::Error> {
        let rows: Vec<(Uuid, SqlxJson<PoiPickRecord>)> = sqlx::query_as(
            "SELECT bbox_id, payload FROM analyses \
             WHERE kind = $1 ORDER BY created_at ASC, bbox_id ASC",
        )
        .bind(POI_PICK_KIND)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(id, j)| (id, j.0.poi)).collect())
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
        let payload = SqlxJson(PoiPickRecord { poi: poi.cloned() });
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
}

/// On-disk shape of a `poi_pick` analyses payload. Keeping the wrapper
/// (rather than serialising `Poi` directly) lets us round-trip
/// "queried Overpass but matched nothing" as `{ "poi": null }`, which
/// is distinguishable from a missing row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PoiPickRecord {
    poi: Option<Poi>,
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
        };
        assert_eq!(
            polygon_wkt(&b),
            "POLYGON((-73.6 45.5, -73.5 45.5, -73.5 45.6, -73.6 45.6, -73.6 45.5))",
        );
    }
}

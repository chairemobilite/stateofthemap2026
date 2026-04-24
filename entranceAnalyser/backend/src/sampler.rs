//! Draw a uniformly-random inhabited cell from the Postgres-backed grid.
//!
//! A `Sampler` is bound to a single `(cell_size_km, epoch)` tuple — the
//! one the `build-grid` binary most recently populated — and caches the
//! grid's maximum density so `/api/bbox/random` can serve the
//! `max_density_ratio` field without a second query per call.

use sqlx::PgPool;

/// A single sampled grid cell with its derived population statistics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SampledCell {
    pub lat: f64,
    pub lon: f64,
    pub pop: f64,
    pub density_per_km2: f64,
    pub max_density_ratio: f64,
}

/// Immutable, `Send + Sync` sampler bound to a specific grid build.
#[derive(Debug, Clone)]
pub struct Sampler {
    pool: PgPool,
    cell_size_km: u32,
    epoch: i16,
    cell_area_km2: f64,
    max_density_per_km2: f64,
}

impl Sampler {
    /// Load the latest `grid_meta` row and build a `Sampler` from it.
    /// Returns `Ok(None)` when no grid has been built yet so the server
    /// can still start and `/api/bbox/random` can surface a 503 with a
    /// helpful hint.
    pub async fn from_latest(pool: PgPool) -> Result<Option<Self>, sqlx::Error> {
        let row: Option<(i32, i16, f32)> = sqlx::query_as(
            "SELECT cell_size_km, epoch, max_pop \
             FROM grid_meta ORDER BY built_at DESC LIMIT 1",
        )
        .fetch_optional(&pool)
        .await?;

        let Some((cell_size_km, epoch, max_pop)) = row else {
            return Ok(None);
        };
        let cell_size_km = cell_size_km as u32;
        let cell_area_km2 = (cell_size_km as f64).powi(2);
        let max_density_per_km2 = max_pop as f64 / cell_area_km2;
        Ok(Some(Self {
            pool,
            cell_size_km,
            epoch,
            cell_area_km2,
            max_density_per_km2,
        }))
    }

    pub fn cell_size_km(&self) -> u32 {
        self.cell_size_km
    }

    pub fn epoch(&self) -> i16 {
        self.epoch
    }

    pub fn max_density_per_km2(&self) -> f64 {
        self.max_density_per_km2
    }

    /// Draw one inhabited cell uniformly at random.
    ///
    /// `ORDER BY random() LIMIT 1` is acceptable at our scale (~800k
    /// rows, dev-only single user). If the grid ever grows or the
    /// workload changes, switch to the `tsm_system_rows` extension and
    /// `TABLESAMPLE SYSTEM_ROWS(1)`.
    pub async fn sample(&self) -> Result<SampledCell, sqlx::Error> {
        let (lat, lon, pop): (f32, f32, f32) = sqlx::query_as(
            "SELECT lat, lon, pop FROM grid_cells \
             WHERE cell_size_km = $1 AND epoch = $2 \
             ORDER BY random() LIMIT 1",
        )
        .bind(self.cell_size_km as i32)
        .bind(self.epoch)
        .fetch_one(&self.pool)
        .await?;
        Ok(self.decorate(lat as f64, lon as f64, pop as f64))
    }

    fn decorate(&self, lat: f64, lon: f64, pop: f64) -> SampledCell {
        let density_per_km2 = pop / self.cell_area_km2;
        let max_density_ratio = if self.max_density_per_km2 > 0.0 {
            density_per_km2 / self.max_density_per_km2
        } else {
            0.0
        };
        SampledCell { lat, lon, pop, density_per_km2, max_density_ratio }
    }

    /// Helper for tests: build a `SampledCell` from raw coordinates
    /// without touching the database.
    #[cfg(test)]
    pub(crate) fn decorate_for_tests(
        cell_size_km: u32,
        max_density_per_km2: f64,
        lat: f64,
        lon: f64,
        pop: f64,
    ) -> SampledCell {
        let cell_area_km2 = (cell_size_km as f64).powi(2);
        let density_per_km2 = pop / cell_area_km2;
        let max_density_ratio = if max_density_per_km2 > 0.0 {
            density_per_km2 / max_density_per_km2
        } else {
            0.0
        };
        SampledCell { lat, lon, pop, density_per_km2, max_density_ratio }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case(1, 100.0, 100.0)]    // 1 km cell, 100 people → 100 / km²
    #[case(2, 100.0, 25.0)]     // 2 km cell (4 km²), 100 people → 25 / km²
    #[case(10, 100.0, 1.0)]     // 10 km cell (100 km²), 100 people → 1 / km²
    fn decorate_computes_density(
        #[case] cell_size_km: u32,
        #[case] pop: f64,
        #[case] expected: f64,
    ) {
        let cell = Sampler::decorate_for_tests(cell_size_km, 1000.0, 0.0, 0.0, pop);
        assert!((cell.density_per_km2 - expected).abs() < 1e-9);
    }

    #[rstest]
    #[case(200.0, 200.0, 1.0)]   // max cell → ratio 1.0
    #[case(10.0, 200.0, 0.05)]   // 10/200 → 0.05
    #[case(0.0, 200.0, 0.0)]     // no people → ratio 0
    fn decorate_computes_max_ratio(
        #[case] pop: f64,
        #[case] max_pop: f64,
        #[case] expected: f64,
    ) {
        let max_density_per_km2 = max_pop / 100.0; // 10 × 10 km → 100 km²
        let cell = Sampler::decorate_for_tests(10, max_density_per_km2, 0.0, 0.0, pop);
        assert!((cell.max_density_ratio - expected).abs() < 1e-9);
    }

    #[test]
    fn zero_max_yields_zero_ratio() {
        let cell = Sampler::decorate_for_tests(10, 0.0, 0.0, 0.0, 5.0);
        assert_eq!(cell.max_density_ratio, 0.0);
    }
}

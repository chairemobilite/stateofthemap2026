//! Draw candidate bboxes from the Postgres-backed grid under one of four
//! sampling strategies.
//!
//! | Strategy     | Weight per cell                                           |
//! |--------------|-----------------------------------------------------------|
//! | `uniform`    | 1 (all inhabited cells equally likely)                    |
//! | `population` | `pop_i`                                                   |
//! | `built`      | `built_i`                                                 |
//! | `blended`    | `α · built_i / Σ built + (1-α) · pop_i / Σ pop`           |
//!
//! The non-uniform strategies use **Efraimidis-Spirakis weighted
//! reservoir sampling**: for each candidate row, generate
//! `random() ^ (1 / weight)` and keep the row with the largest key. The
//! result is an exact probability-proportional-to-size draw in a single
//! SQL statement, no schema gymnastics.
//!
//! **Log-space form (what we actually run).** The naive
//! `random() ^ (1 / weight)` underflows Postgres' `double precision`
//! as soon as `1 / weight` gets large — and for our normalised
//! blended weights (sum = 1 across ~800 k cells, so average weight
//! ~1e-6 and tail cells well below 1e-9) `1 / weight` is in the
//! `1e6 – 1e9` range, which pushes `0.5 ^ (1/weight)` under f64's
//! ~2.2e-308 lower bound. Postgres then raises
//! `value out of range: underflow`, killing the whole query. We
//! therefore rank by the monotone equivalent
//! `ln(1 - random()) / weight DESC`. Taking `ln` of the same
//! expression preserves the ordering; `1 - random()` lives in `(0, 1]`
//! so `ln` is always finite and never underflows. This is the standard
//! Efraimidis-Spirakis-in-exponential-variates trick and is what the
//! original paper actually proves stability for.
//!
//! `blended` defaults to α = 0.5, which is equivalent to flipping a fair
//! coin between `population` and `built` per draw (the two are the same
//! marginal distribution). Normalising each signal by its global sum
//! before blending keeps the weights honest: otherwise the raster with
//! larger raw units (built volume in m³, dwarfing person counts) would
//! silently dominate.

use sqlx::PgPool;

/// Which weighting to apply when drawing a cell.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Strategy {
    /// Every inhabited cell is equally likely. Useful as a diagnostic
    /// baseline; not what the paper's analysis is built on.
    Uniform,
    /// Sample cells in proportion to residential population.
    Population,
    /// Sample cells in proportion to built volume (GHS-BUILT-V). Rescues
    /// industrial complexes, campuses and ports that have lots of
    /// entrances but few residents.
    Built,
    /// Blend population and built volume, each normalised by its global
    /// sum. `alpha` weights the built signal; `1 - alpha` weights
    /// population. The default α=0.5 is equivalent to a fair coin-flip
    /// per draw.
    Blended { alpha: f64 },
}

impl Strategy {
    /// The default blended mix (50/50 built/population).
    pub const DEFAULT_ALPHA: f64 = 0.5;

    /// Whether this strategy needs the grid to carry a populated
    /// `built_volume` column.
    pub fn needs_built(&self) -> bool {
        matches!(self, Strategy::Built | Strategy::Blended { .. })
    }
}

/// A single sampled grid cell with its derived population and built-
/// volume statistics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SampledCell {
    pub lat: f64,
    pub lon: f64,
    pub pop: f64,
    pub built_volume: f64,
    pub density_per_km2: f64,
    pub max_density_ratio: f64,
    /// `built_volume / max_built_volume_in_grid`, in `[0, 1]`. Zero when
    /// the grid has no built-volume data populated.
    pub max_built_volume_ratio: f64,
}

/// Error cases that `sample()` can surface to the HTTP layer.
#[derive(Debug)]
pub enum SampleError {
    /// The requested strategy needs `built_volume > 0` to be populated
    /// but the current grid only carries population data. The HTTP
    /// handler turns this into a 503 with a clear rebuild hint.
    BuiltUnavailable,
    /// Transport / planner error from sqlx.
    Db(sqlx::Error),
}

impl From<sqlx::Error> for SampleError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

impl std::fmt::Display for SampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SampleError::BuiltUnavailable => f.write_str(
                "strategy needs built-volume data; rerun build-grid with --built-volume",
            ),
            SampleError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for SampleError {}

/// Immutable, `Send + Sync` sampler bound to a specific grid build.
#[derive(Debug, Clone)]
pub struct Sampler {
    pool: PgPool,
    cell_size_km: u32,
    epoch: i16,
    cell_area_km2: f64,
    max_density_per_km2: f64,
    max_built_volume: f64,
    total_pop: f64,
    total_built: f64,
}

impl Sampler {
    /// Load the latest `grid_meta` row and build a `Sampler` from it.
    /// Returns `Ok(None)` when no grid has been built yet so the server
    /// can still start and `/api/bbox/random` can surface a 503 with a
    /// helpful hint.
    pub async fn from_latest(pool: PgPool) -> Result<Option<Self>, sqlx::Error> {
        let row: Option<(i32, i16, f32, f32, f64, f64)> = sqlx::query_as(
            "SELECT cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built \
             FROM grid_meta ORDER BY built_at DESC LIMIT 1",
        )
        .fetch_optional(&pool)
        .await?;

        let Some((cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built)) = row
        else {
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
            max_built_volume: max_built_volume as f64,
            total_pop,
            total_built,
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

    pub fn max_built_volume(&self) -> f64 {
        self.max_built_volume
    }

    /// Whether the grid has a populated `built_volume` column.
    pub fn has_built_data(&self) -> bool {
        self.total_built > 0.0
    }

    /// Draw one cell under the given strategy.
    ///
    /// The non-uniform queries are single full seq-scans of
    /// `grid_cells`, ~100-200 ms at our scale (~800k inhabited 10 km
    /// cells). Acceptable for a single-operator workflow; swap to a
    /// cumulative-sum + indexed lookup if we ever run batched draws.
    pub async fn sample(&self, strategy: Strategy) -> Result<SampledCell, SampleError> {
        if strategy.needs_built() && !self.has_built_data() {
            return Err(SampleError::BuiltUnavailable);
        }
        let (lat, lon, pop, built): (f32, f32, f32, f32) = match strategy {
            Strategy::Uniform => self.query_uniform().await?,
            Strategy::Population => self.query_weighted_by("pop", "pop > 0").await?,
            Strategy::Built => {
                self.query_weighted_by("built_volume", "built_volume > 0")
                    .await?
            }
            Strategy::Blended { alpha } => self.query_blended(alpha).await?,
        };
        Ok(self.decorate(lat as f64, lon as f64, pop as f64, built as f64))
    }

    async fn query_uniform(&self) -> Result<(f32, f32, f32, f32), sqlx::Error> {
        sqlx::query_as(
            "SELECT lat, lon, pop, built_volume FROM grid_cells \
             WHERE cell_size_km = $1 AND epoch = $2 \
             ORDER BY random() LIMIT 1",
        )
        .bind(self.cell_size_km as i32)
        .bind(self.epoch)
        .fetch_one(&self.pool)
        .await
    }

    /// Efraimidis-Spirakis on a single raw column. `weight_col` is an
    /// identifier ("pop" or "built_volume") inlined into the query;
    /// `where_extra` filters out rows that would divide by zero.
    async fn query_weighted_by(
        &self,
        weight_col: &'static str,
        where_extra: &'static str,
    ) -> Result<(f32, f32, f32, f32), sqlx::Error> {
        // Log-space Efraimidis-Spirakis: ln(1 - random()) / weight DESC
        // is the monotone equivalent of random() ^ (1 / weight) DESC, but
        // never underflows double precision for small weights. See the
        // module-level doc.
        let sql = format!(
            "SELECT lat, lon, pop, built_volume FROM grid_cells \
             WHERE cell_size_km = $1 AND epoch = $2 AND {where_extra} \
             ORDER BY ln(1.0 - random()) / {weight_col}::double precision DESC \
             LIMIT 1"
        );
        sqlx::query_as(&sql)
            .bind(self.cell_size_km as i32)
            .bind(self.epoch)
            .fetch_one(&self.pool)
            .await
    }

    /// Efraimidis-Spirakis on the normalised blended weight
    /// `α · built/total_built + (1-α) · pop/total_pop`. Filters out
    /// rows with zero blended weight so the `ln(random()) / 0` edge
    /// case never happens. Uses the log-space form (see module doc)
    /// because normalised weights are ~1e-11..1e-4 — the naive
    /// `random() ^ (1/w)` would underflow double precision for every
    /// row and Postgres would raise `value out of range: underflow`.
    async fn query_blended(&self, alpha: f64) -> Result<(f32, f32, f32, f32), sqlx::Error> {
        let alpha = alpha.clamp(0.0, 1.0);
        let pop_coeff = (1.0 - alpha) / self.total_pop;
        let built_coeff = alpha / self.total_built;
        sqlx::query_as(
            "SELECT lat, lon, pop, built_volume FROM grid_cells \
             WHERE cell_size_km = $1 AND epoch = $2 \
               AND ($3 * pop::double precision + $4 * built_volume::double precision) > 0 \
             ORDER BY ln(1.0 - random()) / \
                ($3 * pop::double precision + $4 * built_volume::double precision) \
                DESC LIMIT 1",
        )
        .bind(self.cell_size_km as i32)
        .bind(self.epoch)
        .bind(pop_coeff)
        .bind(built_coeff)
        .fetch_one(&self.pool)
        .await
    }

    fn decorate(&self, lat: f64, lon: f64, pop: f64, built_volume: f64) -> SampledCell {
        let density_per_km2 = pop / self.cell_area_km2;
        let max_density_ratio = if self.max_density_per_km2 > 0.0 {
            density_per_km2 / self.max_density_per_km2
        } else {
            0.0
        };
        let max_built_volume_ratio = if self.max_built_volume > 0.0 {
            built_volume / self.max_built_volume
        } else {
            0.0
        };
        SampledCell {
            lat,
            lon,
            pop,
            built_volume,
            density_per_km2,
            max_density_ratio,
            max_built_volume_ratio,
        }
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
        Self::decorate_for_tests_full(cell_size_km, max_density_per_km2, 0.0, lat, lon, pop, 0.0)
    }

    /// Helper for tests: decorate with all stats including built volume.
    #[cfg(test)]
    pub(crate) fn decorate_for_tests_full(
        cell_size_km: u32,
        max_density_per_km2: f64,
        max_built_volume: f64,
        lat: f64,
        lon: f64,
        pop: f64,
        built_volume: f64,
    ) -> SampledCell {
        let cell_area_km2 = (cell_size_km as f64).powi(2);
        let density_per_km2 = pop / cell_area_km2;
        let max_density_ratio = if max_density_per_km2 > 0.0 {
            density_per_km2 / max_density_per_km2
        } else {
            0.0
        };
        let max_built_volume_ratio = if max_built_volume > 0.0 {
            built_volume / max_built_volume
        } else {
            0.0
        };
        SampledCell {
            lat,
            lon,
            pop,
            built_volume,
            density_per_km2,
            max_density_ratio,
            max_built_volume_ratio,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case(1, 100.0, 100.0)] // 1 km cell, 100 people → 100 / km²
    #[case(2, 100.0, 25.0)] // 2 km cell (4 km²), 100 people → 25 / km²
    #[case(10, 100.0, 1.0)] // 10 km cell (100 km²), 100 people → 1 / km²
    fn decorate_computes_density(
        #[case] cell_size_km: u32,
        #[case] pop: f64,
        #[case] expected: f64,
    ) {
        let cell = Sampler::decorate_for_tests(cell_size_km, 1000.0, 0.0, 0.0, pop);
        assert!((cell.density_per_km2 - expected).abs() < 1e-9);
    }

    #[rstest]
    #[case(200.0, 200.0, 1.0)] // max cell → ratio 1.0
    #[case(10.0, 200.0, 0.05)] // 10/200 → 0.05
    #[case(0.0, 200.0, 0.0)] // no people → ratio 0
    fn decorate_computes_max_ratio(#[case] pop: f64, #[case] max_pop: f64, #[case] expected: f64) {
        let max_density_per_km2 = max_pop / 100.0; // 10 × 10 km → 100 km²
        let cell = Sampler::decorate_for_tests(10, max_density_per_km2, 0.0, 0.0, pop);
        assert!((cell.max_density_ratio - expected).abs() < 1e-9);
    }

    #[rstest]
    #[case(500.0, 2000.0, 0.25)] // 500 / 2000 → 0.25
    #[case(2000.0, 2000.0, 1.0)] // top built cell → 1.0
    #[case(0.0, 2000.0, 0.0)] // no built volume → 0
    fn decorate_computes_max_built_ratio(
        #[case] built: f64,
        #[case] max_built: f64,
        #[case] expected: f64,
    ) {
        let cell = Sampler::decorate_for_tests_full(10, 10.0, max_built, 0.0, 0.0, 100.0, built);
        assert!((cell.max_built_volume_ratio - expected).abs() < 1e-9);
    }

    #[test]
    fn zero_max_yields_zero_ratio() {
        let cell = Sampler::decorate_for_tests(10, 0.0, 0.0, 0.0, 5.0);
        assert_eq!(cell.max_density_ratio, 0.0);
        assert_eq!(cell.max_built_volume_ratio, 0.0);
    }

    #[rstest]
    #[case(Strategy::Uniform, false)]
    #[case(Strategy::Population, false)]
    #[case(Strategy::Built, true)]
    #[case(Strategy::Blended { alpha: 0.5 }, true)]
    fn needs_built_flags_the_right_strategies(#[case] strategy: Strategy, #[case] expected: bool) {
        assert_eq!(strategy.needs_built(), expected);
    }
}

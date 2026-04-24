//! Aggregate GHS-POP (and optionally GHS-BUILT-V) into the entrance-analyser
//! Postgres grid.
//!
//! Run once after downloading the source GeoTIFFs (see
//! `entranceAnalyser/README.md` for URLs and citations). The aggregated
//! super-cells are written to the `grid_cells` / `grid_meta` tables and
//! consumed at runtime by the HTTP backend's `/api/bbox/random` endpoint.
//!
//! ```sh
//! entrance-analyser-build-grid \
//!     --input         GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
//!     --built-volume  GHS_BUILT_V_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
//!     --cell-size-km  10
//! ```
//!
//! `--built-volume` is optional: if omitted, `built_volume` stays at 0
//! for every cell and only the `uniform` / `population` sampling
//! strategies will work at runtime (the `built` / `blended` strategies
//! will surface a 503 with a clear hint).
//!
//! Writing is idempotent per `(cell_size_km, epoch)`: existing rows with
//! the same pair are replaced atomically inside a single transaction.

use std::path::{Path, PathBuf};
use std::time::Instant;

use clap::Parser;
use entrance_analyser_backend::aggregate::Aggregator;
use entrance_analyser_backend::config::{self, DbKind};
use entrance_analyser_backend::db;
use entrance_analyser_backend::geotiff_pop::{GeoTransform, PopReader};
use entrance_analyser_backend::mollweide;
use sqlx::PgPool;

/// One aggregated super-cell, ready to be inserted.
#[derive(Debug, Clone, Copy)]
struct Cell {
    lat: f32,
    lon: f32,
    pop: f32,
    built_volume: f32,
}

/// Cached summary statistics for the whole build, written into `grid_meta`
/// so the runtime sampler can compose normalized blended weights without
/// a table scan.
#[derive(Debug, Clone, Copy, Default)]
struct Summary {
    max_pop: f32,
    max_built: f32,
    total_pop: f64,
    total_built: f64,
}

/// CLI arguments. Cell size is configurable down to the source's native
/// 1 km resolution; defaults to 10 km which is a good trade-off between
/// storage footprint (~800k rows globally) and locality (a 10 × 10 km
/// box is roughly the size of a small city).
#[derive(Parser, Debug)]
#[command(version, about = "Aggregate GHS-POP (+ optional GHS-BUILT-V) into the entrance-analyser Postgres grid")]
struct Args {
    /// Path to the GHS-POP Mollweide GeoTIFF (.tif, unzipped).
    #[arg(long)]
    input: PathBuf,

    /// Optional path to the matching GHS-BUILT-V Mollweide GeoTIFF. When
    /// supplied, `built_volume` is populated per cell so the sampler can
    /// run the `built` / `blended` strategies. When omitted, the column
    /// stays at 0.
    #[arg(long)]
    built_volume: Option<PathBuf>,

    /// Target database URL. Defaults to `PG_CONNECTION_STRING_PREFIX + PG_DATABASE`
    /// from the environment (loaded from `.env` if present).
    #[arg(long)]
    database_url: Option<String>,

    /// Aggregated cell side in kilometres. Must be >= 1 (the source raster's
    /// native resolution) and <= 100.
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u32).range(1..=100))]
    cell_size_km: u32,

    /// GHS epoch year (only metadata, not validated against the file).
    #[arg(long, default_value_t = 2020)]
    epoch: u16,

    /// Minimum population for a super-cell to be kept when no built-volume
    /// raster is supplied. Defaults to 0.5 - keeps every cell with at
    /// least one person and drops the empty/ocean ones.
    #[arg(long, default_value_t = 0.5)]
    min_population: f32,

    /// Minimum built volume (m³) for a super-cell to be kept on its own
    /// (purely-industrial cell without residents). Only meaningful when
    /// `--built-volume` is supplied. Default 0.5 m³ drops sea / empty
    /// cells without dropping the smallest hamlets or isolated buildings.
    #[arg(long, default_value_t = 0.5)]
    min_built_volume: f32,
}

/// Number of rows to ship per `INSERT ... SELECT UNNEST(...)` statement.
/// 5000 keeps each packet comfortably under Postgres' parameter and
/// message-size limits while still amortising round-trips.
const INSERT_CHUNK: usize = 5000;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let started = Instant::now();

    config::load_dotenv();
    let database_url = match &args.database_url {
        Some(url) => url.clone(),
        None => config::database_url(DbKind::App)?,
    };

    let (cells, summary) = aggregate(&args)?;
    println!(
        "kept {} cells | pop: total = {:.0}, max = {:.0} | built_v: total = {:.0}, max = {:.0}",
        cells.len(),
        summary.total_pop, summary.max_pop,
        summary.total_built, summary.max_built,
    );

    let pool = db::connect(&database_url).await?;
    db::run_migrations(&pool).await?;
    write_to_postgres(&pool, args.cell_size_km, args.epoch, summary, &cells).await?;
    pool.close().await;

    println!(
        "wrote {} cells to {} in {:.1}s",
        cells.len(), database_url, started.elapsed().as_secs_f64(),
    );
    Ok(())
}

/// Stream the source rasters through the aggregator(s) and return the
/// populated super-cells plus per-grid summary statistics. When a built
/// raster is supplied the two dense grids are merged index-by-index —
/// they share dimensions because GHS-POP and GHS-BUILT-V are published on
/// the same Mollweide grid.
fn aggregate(args: &Args) -> Result<(Vec<Cell>, Summary), Box<dyn std::error::Error>> {
    let pop = aggregate_one(&args.input, args.cell_size_km, "population")?;

    let built_dense: Option<Vec<f32>> = match &args.built_volume {
        None => None,
        Some(path) => {
            let b = aggregate_one(path, args.cell_size_km, "built_volume")?;
            if (b.out_width, b.out_height) != (pop.out_width, pop.out_height) {
                return Err(format!(
                    "built-volume raster shape {}×{} does not match population shape {}×{}",
                    b.out_width, b.out_height, pop.out_width, pop.out_height,
                ).into());
            }
            Some(b.dense)
        }
    };

    let half = (pop.factor as f64 - 1.0) / 2.0;
    let mut cells = Vec::new();
    let mut summary = Summary::default();
    for (idx, &pop_v) in pop.dense.iter().enumerate() {
        let built_v = built_dense.as_ref().map_or(0.0, |b| b[idx]);
        let keep_pop = pop_v >= args.min_population;
        let keep_built = built_dense.is_some() && built_v >= args.min_built_volume;
        if !(keep_pop || keep_built) {
            continue;
        }
        let ox = idx % pop.out_width;
        let oy = idx / pop.out_width;
        let pixel_x = (ox * pop.factor) as f64 + half;
        let pixel_y = (oy * pop.factor) as f64 + half;
        let (mx, my) = pop.geotransform.pixel_center(pixel_x, pixel_y);
        let (lat, lon) = mollweide::inverse(mx, my);
        cells.push(Cell {
            lat: lat as f32,
            lon: lon as f32,
            pop: pop_v,
            built_volume: built_v,
        });
        summary.max_pop = summary.max_pop.max(pop_v);
        summary.max_built = summary.max_built.max(built_v);
        summary.total_pop += pop_v as f64;
        summary.total_built += built_v as f64;
    }
    Ok((cells, summary))
}

/// Aggregation result for a single raster, ready to be merged with a
/// sibling raster of identical dimensions.
struct AggregatedRaster {
    dense: Vec<f32>,
    out_width: usize,
    out_height: usize,
    factor: usize,
    geotransform: GeoTransform,
}

/// Aggregate a single raster at `cell_size_km`. `label` is only used for
/// progress logging so build logs are self-describing when two rasters
/// run back-to-back.
fn aggregate_one(
    path: &Path,
    cell_size_km: u32,
    label: &str,
) -> Result<AggregatedRaster, Box<dyn std::error::Error>> {
    let mut reader = PopReader::open(path)?;
    println!(
        "[{label}] source: {} × {} px @ {:.3} km/px (Mollweide)",
        reader.width, reader.height, reader.native_pixel_km(),
    );

    let native_km = reader.native_pixel_km();
    if (native_km - native_km.round()).abs() > 1e-3 {
        return Err(format!(
            "[{label}] expected an integer-km native resolution, got {native_km:.6} km/px",
        ).into());
    }
    let native_km = native_km.round() as u32;
    if cell_size_km < native_km {
        return Err(format!(
            "[{label}] --cell-size-km ({cell_size_km}) must be >= the native resolution ({native_km} km)",
        ).into());
    }
    if !cell_size_km.is_multiple_of(native_km) {
        return Err(format!(
            "[{label}] --cell-size-km ({cell_size_km}) must be a multiple of the native resolution ({native_km} km)",
        ).into());
    }
    let factor = (cell_size_km / native_km) as usize;

    let mut aggregator = Aggregator::new(reader.width as usize, reader.height as usize, factor);
    println!(
        "[{label}] aggregating into {} × {} cells of {} × {} km (factor = {})",
        aggregator.out_width, aggregator.out_height,
        cell_size_km, cell_size_km, factor,
    );

    let mut chunks_seen = 0_u64;
    reader.for_each_pixel(|ox, oy, w, h, pixels| {
        chunks_seen += 1;
        aggregator.ingest(ox, oy, w, h, pixels);
        if chunks_seen.is_multiple_of(200) {
            print!("\r  [{label}] chunks: {chunks_seen}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    })?;
    println!("\r  [{label}] chunks: {chunks_seen} done");

    let out_width = aggregator.out_width;
    let out_height = aggregator.out_height;
    Ok(AggregatedRaster {
        dense: aggregator.into_dense(),
        out_width,
        out_height,
        factor,
        geotransform: reader.geotransform,
    })
}

/// Replace the existing grid for `(cell_size_km, epoch)` atomically.
async fn write_to_postgres(
    pool: &PgPool,
    cell_size_km: u32,
    epoch: u16,
    summary: Summary,
    cells: &[Cell],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    // Clear any previous build of the same (cell_size_km, epoch). The
    // `grid_cells` rows are cleaned up by the FK's ON DELETE CASCADE.
    sqlx::query("DELETE FROM grid_meta WHERE cell_size_km = $1 AND epoch = $2")
        .bind(cell_size_km as i32)
        .bind(epoch as i16)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO grid_meta \
         (cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(cell_size_km as i32)
    .bind(epoch as i16)
    .bind(summary.max_pop)
    .bind(summary.max_built)
    .bind(summary.total_pop)
    .bind(summary.total_built)
    .execute(&mut *tx)
    .await?;

    for chunk in cells.chunks(INSERT_CHUNK) {
        let lats: Vec<f32> = chunk.iter().map(|c| c.lat).collect();
        let lons: Vec<f32> = chunk.iter().map(|c| c.lon).collect();
        let pops: Vec<f32> = chunk.iter().map(|c| c.pop).collect();
        let bvs:  Vec<f32> = chunk.iter().map(|c| c.built_volume).collect();
        sqlx::query(
            "INSERT INTO grid_cells \
             (cell_size_km, epoch, lat, lon, pop, built_volume, geom) \
             SELECT $1, $2, lat, lon, pop, built_volume, \
                    ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326) \
             FROM UNNEST($3::real[], $4::real[], $5::real[], $6::real[]) \
                AS t(lat, lon, pop, built_volume)",
        )
        .bind(cell_size_km as i32)
        .bind(epoch as i16)
        .bind(&lats)
        .bind(&lons)
        .bind(&pops)
        .bind(&bvs)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await
}

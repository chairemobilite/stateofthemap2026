//! Aggregate the GHS-POP raster into the entrance-analyser Postgres grid.
//!
//! Run once after downloading the source GeoTIFF (see
//! `entranceAnalyser/README.md` for the URL and citation). The aggregated
//! super-cells are written to the `grid_cells` / `grid_meta` tables and
//! consumed at runtime by the HTTP backend's `/api/bbox/random` endpoint.
//!
//! ```sh
//! entrance-analyser-build-grid \
//!     --input GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
//!     --cell-size-km 10
//! ```
//!
//! Writing is idempotent per `(cell_size_km, epoch)`: existing rows with
//! the same pair are replaced atomically inside a single transaction.

use std::path::PathBuf;
use std::time::Instant;

use clap::Parser;
use entrance_analyser_backend::aggregate::Aggregator;
use entrance_analyser_backend::config::{self, DbKind};
use entrance_analyser_backend::db;
use entrance_analyser_backend::geotiff_pop::PopReader;
use entrance_analyser_backend::mollweide;
use sqlx::PgPool;

/// One aggregated super-cell, ready to be inserted.
#[derive(Debug, Clone, Copy)]
struct Cell {
    lat: f32,
    lon: f32,
    pop: f32,
}

/// CLI arguments. Cell size is configurable down to the source's native
/// 1 km resolution; defaults to 10 km which is a good trade-off between
/// storage footprint (~800k rows globally) and locality (a 10 × 10 km
/// box is roughly the size of a small city).
#[derive(Parser, Debug)]
#[command(version, about = "Aggregate GHS-POP into the entrance-analyser Postgres grid")]
struct Args {
    /// Path to the GHS-POP Mollweide GeoTIFF (.tif, unzipped).
    #[arg(long)]
    input: PathBuf,

    /// Target database URL. Defaults to `PG_CONNECTION_STRING_PREFIX + PG_DATABASE`
    /// from the environment (loaded from `.env` if present).
    #[arg(long)]
    database_url: Option<String>,

    /// Aggregated cell side in kilometres. Must be >= 1 (the source raster's
    /// native resolution) and <= 100.
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u32).range(1..=100))]
    cell_size_km: u32,

    /// GHS-POP epoch year (only metadata, not validated against the file).
    #[arg(long, default_value_t = 2020)]
    epoch: u16,

    /// Drop super-cells whose total population is below this threshold.
    /// Defaults to 0.5 - keeps every cell with at least one person and
    /// drops the empty/ocean ones.
    #[arg(long, default_value_t = 0.5)]
    min_population: f32,
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

    let cells = aggregate(&args)?;
    let total_pop: f64 = cells.iter().map(|c| c.pop as f64).sum();
    let max_pop = cells.iter().map(|c| c.pop).fold(0.0_f32, f32::max);
    println!(
        "kept {} inhabited cells, total population = {:.0}, max cell = {:.0}",
        cells.len(), total_pop, max_pop,
    );

    let pool = db::connect(&database_url).await?;
    db::run_migrations(&pool).await?;
    write_to_postgres(&pool, args.cell_size_km, args.epoch, max_pop, &cells).await?;
    pool.close().await;

    println!(
        "wrote {} cells to {} in {:.1}s",
        cells.len(), database_url, started.elapsed().as_secs_f64(),
    );
    Ok(())
}

/// Stream the source TIFF through the aggregator and return the
/// populated super-cells with their lat/lon centres.
fn aggregate(args: &Args) -> Result<Vec<Cell>, Box<dyn std::error::Error>> {
    let mut reader = PopReader::open(&args.input)?;
    println!(
        "source: {} × {} px @ {:.3} km/px (Mollweide)",
        reader.width, reader.height, reader.native_pixel_km(),
    );

    let native_km = reader.native_pixel_km();
    if (native_km - native_km.round()).abs() > 1e-3 {
        return Err(format!(
            "expected an integer-km native resolution, got {native_km:.6} km/px",
        ).into());
    }
    let native_km = native_km.round() as u32;
    if args.cell_size_km < native_km {
        return Err(format!(
            "--cell-size-km ({}) must be >= the native resolution ({} km)",
            args.cell_size_km, native_km,
        ).into());
    }
    if args.cell_size_km % native_km != 0 {
        return Err(format!(
            "--cell-size-km ({}) must be a multiple of the native resolution ({} km)",
            args.cell_size_km, native_km,
        ).into());
    }
    let factor = (args.cell_size_km / native_km) as usize;

    let mut aggregator = Aggregator::new(reader.width as usize, reader.height as usize, factor);
    println!(
        "aggregating into {} × {} cells of {} × {} km (factor = {})",
        aggregator.out_width, aggregator.out_height,
        args.cell_size_km, args.cell_size_km, factor,
    );

    let mut chunks_seen = 0_u64;
    reader.for_each_pixel(|ox, oy, w, h, pixels| {
        chunks_seen += 1;
        aggregator.ingest(ox, oy, w, h, pixels);
        if chunks_seen.is_multiple_of(200) {
            print!("\r  chunks: {chunks_seen}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    })?;
    println!("\r  chunks: {chunks_seen} done");

    let geotransform = reader.geotransform;
    // Average native-pixel index inside a super-cell of side `factor`
    // covers pixels [k*factor, k*factor + factor), centre at
    // k*factor + (factor - 1)/2.
    let half = (factor as f64 - 1.0) / 2.0;
    let cells = aggregator
        .finish(args.min_population)
        .map(|(ox, oy, pop)| {
            let pixel_x = (ox * factor) as f64 + half;
            let pixel_y = (oy * factor) as f64 + half;
            let (mx, my) = geotransform.pixel_center(pixel_x, pixel_y);
            let (lat, lon) = mollweide::inverse(mx, my);
            Cell { lat: lat as f32, lon: lon as f32, pop }
        })
        .collect();
    Ok(cells)
}

/// Replace the existing grid for `(cell_size_km, epoch)` atomically.
async fn write_to_postgres(
    pool: &PgPool,
    cell_size_km: u32,
    epoch: u16,
    max_pop: f32,
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
        "INSERT INTO grid_meta (cell_size_km, epoch, max_pop) VALUES ($1, $2, $3)",
    )
    .bind(cell_size_km as i32)
    .bind(epoch as i16)
    .bind(max_pop)
    .execute(&mut *tx)
    .await?;

    for chunk in cells.chunks(INSERT_CHUNK) {
        let lats: Vec<f32> = chunk.iter().map(|c| c.lat).collect();
        let lons: Vec<f32> = chunk.iter().map(|c| c.lon).collect();
        let pops: Vec<f32> = chunk.iter().map(|c| c.pop).collect();
        sqlx::query(
            "INSERT INTO grid_cells (cell_size_km, epoch, lat, lon, pop, geom) \
             SELECT $1, $2, lat, lon, pop, \
                    ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326) \
             FROM UNNEST($3::real[], $4::real[], $5::real[]) AS t(lat, lon, pop)",
        )
        .bind(cell_size_km as i32)
        .bind(epoch as i16)
        .bind(&lats)
        .bind(&lons)
        .bind(&pops)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await
}

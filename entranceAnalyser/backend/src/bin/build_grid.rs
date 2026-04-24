//! Aggregate the GHS-POP raster into the entrance-analyser grid file.
//!
//! Run once after downloading the source GeoTIFF (see
//! `entranceAnalyser/README.md` for the URL and citation). The output file
//! is consumed at runtime by the HTTP backend's `/api/bbox/random`
//! endpoint.
//!
//! ```sh
//! entrance-analyser-build-grid \
//!     --input  GHS_POP_E2020_GLOBE_R2023A_54009_1000_V1_0.tif \
//!     --output data/world_grid_2020_10km.bin \
//!     --cell-size-km 10
//! ```

use std::path::PathBuf;
use std::time::Instant;

use clap::Parser;
use entrance_analyser_backend::aggregate::Aggregator;
use entrance_analyser_backend::geotiff_pop::PopReader;
use entrance_analyser_backend::grid::{Cell, GridFile};
use entrance_analyser_backend::mollweide;

/// CLI arguments. Cell size is configurable down to the source's native
/// 1 km resolution; defaults to 10 km which is a good trade-off between
/// file size (~12 MB) and locality (a 10 × 10 km box is roughly the size
/// of a small city).
#[derive(Parser, Debug)]
#[command(version, about = "Aggregate GHS-POP into the entrance-analyser grid file")]
struct Args {
    /// Path to the GHS-POP Mollweide GeoTIFF (.tif, unzipped).
    #[arg(long)]
    input: PathBuf,

    /// Output grid file (`*.bin`).
    #[arg(long)]
    output: PathBuf,

    /// Aggregated cell side in kilometres. Must be ≥ 1 (the source raster's
    /// native resolution) and ≤ 100.
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u32).range(1..=100))]
    cell_size_km: u32,

    /// GHS-POP epoch year (only metadata, not validated against the file).
    #[arg(long, default_value_t = 2020)]
    epoch: u16,

    /// Drop super-cells whose total population is below this threshold.
    /// Defaults to 0.5 — keeps every cell with at least one person and
    /// drops the empty/ocean ones.
    #[arg(long, default_value_t = 0.5)]
    min_population: f32,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let started = Instant::now();

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
            "--cell-size-km ({}) must be ≥ the native resolution ({} km)",
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

    // Re-grab the geotransform after the move-into-closure dance.
    let geotransform = reader.geotransform;

    // Average native-pixel index inside a super-cell of side `factor`:
    // covers pixels [k*factor, k*factor + factor), centre at
    // k*factor + (factor - 1)/2.
    let half = (factor as f64 - 1.0) / 2.0;
    let cells: Vec<Cell> = aggregator
        .finish(args.min_population)
        .map(|(ox, oy, pop)| {
            let pixel_x = (ox * factor) as f64 + half;
            let pixel_y = (oy * factor) as f64 + half;
            let (mx, my) = geotransform.pixel_center(pixel_x, pixel_y);
            let (lat, lon) = mollweide::inverse(mx, my);
            Cell { lat: lat as f32, lon: lon as f32, pop }
        })
        .collect();

    let grid = GridFile::new(args.cell_size_km, args.epoch, cells);
    let total_pop: f64 = grid.cells.iter().map(|c| c.pop as f64).sum();
    println!(
        "kept {} inhabited cells, total population = {:.0}, max cell = {:.0}",
        grid.cells.len(), total_pop, grid.max_pop,
    );

    if let Some(parent) = args.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args.output)?);
    grid.write_to(&mut out)?;
    drop(out);
    let bytes = std::fs::metadata(&args.output)?.len();
    println!(
        "wrote {} ({} bytes) in {:.1}s",
        args.output.display(), bytes, started.elapsed().as_secs_f64(),
    );
    Ok(())
}

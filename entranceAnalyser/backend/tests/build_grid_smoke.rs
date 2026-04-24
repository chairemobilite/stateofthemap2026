//! End-to-end smoke test for the `entrance-analyser-build-grid` binary.
//!
//! Synthesises a tiny 4 × 4 px Float32 GeoTIFF in a temp dir with
//! Mollweide-style geo tags, invokes the released binary against it,
//! and reads the resulting grid file back to verify the pipeline.

use std::fs::File;
use std::io::BufWriter;
use std::process::Command;

use entrance_analyser_backend::grid::GridFile;
use tempfile::TempDir;
use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
use tiff::tags::Tag;

/// 4 × 4 pixels, factor = 2 → 2 × 2 super-cells. Top-left at
/// `(0, 0)` Mollweide (so all four super-cells sit on the equator,
/// straddling the prime meridian) with 1 km square pixels.
fn write_synthetic_geotiff(path: &std::path::Path, pixels: &[f32]) {
    assert_eq!(pixels.len(), 16);
    let mut out = BufWriter::new(File::create(path).unwrap());
    let mut enc = TiffEncoder::new(&mut out).unwrap();
    let mut img = enc.new_image::<Gray32Float>(4, 4).unwrap();
    img.encoder()
        .write_tag(Tag::ModelPixelScaleTag, &[1000.0_f64, 1000.0, 0.0][..])
        .unwrap();
    img.encoder()
        .write_tag(
            Tag::ModelTiepointTag,
            &[0.0_f64, 0.0, 0.0, -2000.0, 2000.0, 0.0][..],
        )
        .unwrap();
    img.write_data(pixels).unwrap();
}

#[test]
fn build_grid_aggregates_synthetic_tiff() {
    let dir = TempDir::new().unwrap();
    let tif = dir.path().join("synth.tif");
    let bin = dir.path().join("out.bin");

    let pixels: Vec<f32> = vec![
        // upper-left super-cell sums to 4, upper-right to 8,
        // lower-left to 0 (gets dropped), lower-right to 16
        1.0, 1.0, 2.0, 2.0,
        1.0, 1.0, 2.0, 2.0,
        0.0, 0.0, 4.0, 4.0,
        0.0, 0.0, 4.0, 4.0,
    ];
    write_synthetic_geotiff(&tif, &pixels);

    let exe = env!("CARGO_BIN_EXE_entrance-analyser-build-grid");
    let status = Command::new(exe)
        .args([
            "--input", tif.to_str().unwrap(),
            "--output", bin.to_str().unwrap(),
            "--cell-size-km", "2",
            "--epoch", "2020",
            "--min-population", "0.5",
        ])
        .status()
        .expect("binary runs");
    assert!(status.success(), "build-grid exited with {status}");

    let grid = GridFile::read_from(File::open(&bin).unwrap()).unwrap();
    assert_eq!(grid.cell_size_km, 2);
    assert_eq!(grid.epoch, 2020);
    assert_eq!(grid.cells.len(), 3, "lower-left empty cell should be dropped");
    assert_eq!(grid.max_pop, 16.0);

    let mut by_pop: Vec<f32> = grid.cells.iter().map(|c| c.pop).collect();
    by_pop.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(by_pop, vec![4.0, 8.0, 16.0]);

    // All cells sit very close to (0°, 0°) — the synthetic raster is a
    // 4 km square centred on the Mollweide origin, so every cell centre
    // is within ~0.02° of the equator/prime meridian.
    for c in &grid.cells {
        assert!(c.lat.abs() < 0.02, "lat = {}", c.lat);
        assert!(c.lon.abs() < 0.02, "lon = {}", c.lon);
    }
}

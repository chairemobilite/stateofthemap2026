//! End-to-end smoke test for the `entrance-analyser-build-grid` binary.
//!
//! Synthesises a tiny 4 × 4 px Float32 GeoTIFF in a temp dir with
//! Mollweide-style geo tags, invokes the released binary against an
//! ephemeral Postgres database, and checks that the expected rows land
//! in `grid_meta` / `grid_cells` with a valid PostGIS geometry.

mod common;

use std::fs::File;
use std::io::BufWriter;
use std::process::Command;

use sqlx::Row;
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

#[tokio::test]
async fn build_grid_aggregates_synthetic_tiff() {
    let Some(db) = common::pg_or_skip().await else { return };

    let dir = TempDir::new().unwrap();
    let tif = dir.path().join("synth.tif");

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
            "--database-url", &db.url,
            "--cell-size-km", "2",
            "--epoch", "2020",
            "--min-population", "0.5",
        ])
        .status()
        .expect("binary runs");
    assert!(status.success(), "build-grid exited with {status}");

    // grid_meta carries exactly one row for our (cell_size_km, epoch) pair.
    let (cell_size, epoch, max_pop): (i32, i16, f32) = sqlx::query_as(
        "SELECT cell_size_km, epoch, max_pop FROM grid_meta",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(cell_size, 2);
    assert_eq!(epoch, 2020);
    assert_eq!(max_pop, 16.0);

    // Three inhabited super-cells, sorted by population.
    let rows = sqlx::query(
        "SELECT lat, lon, pop, ST_SRID(geom) AS srid, GeometryType(geom) AS gtype \
         FROM grid_cells ORDER BY pop",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3, "lower-left empty cell should be dropped");

    let pops: Vec<f32> = rows.iter().map(|r| r.get::<f32, _>("pop")).collect();
    assert_eq!(pops, vec![4.0, 8.0, 16.0]);

    // All cells sit very close to (0°, 0°) with a valid PostGIS Point
    // in EPSG:4326.
    for r in &rows {
        let lat: f32 = r.get("lat");
        let lon: f32 = r.get("lon");
        let srid: i32 = r.get("srid");
        let gtype: String = r.get("gtype");
        assert!(lat.abs() < 0.02, "lat = {lat}");
        assert!(lon.abs() < 0.02, "lon = {lon}");
        assert_eq!(srid, 4326);
        assert_eq!(gtype, "POINT");
    }

    db.cleanup().await.ok();
}

#[tokio::test]
async fn build_grid_is_idempotent() {
    let Some(db) = common::pg_or_skip().await else { return };

    let dir = TempDir::new().unwrap();
    let tif = dir.path().join("synth.tif");
    let pixels: Vec<f32> = vec![
        1.0, 1.0, 2.0, 2.0,
        1.0, 1.0, 2.0, 2.0,
        0.0, 0.0, 4.0, 4.0,
        0.0, 0.0, 4.0, 4.0,
    ];
    write_synthetic_geotiff(&tif, &pixels);

    let exe = env!("CARGO_BIN_EXE_entrance-analyser-build-grid");
    for _ in 0..2 {
        let status = Command::new(exe)
            .args([
                "--input", tif.to_str().unwrap(),
                "--database-url", &db.url,
                "--cell-size-km", "2",
            ])
            .status()
            .unwrap();
        assert!(status.success());
    }

    let meta_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM grid_meta")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let cells_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM grid_cells")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(meta_count, 1, "re-running must not duplicate grid_meta rows");
    assert_eq!(cells_count, 3, "re-running must replace grid_cells, not append");

    db.cleanup().await.ok();
}

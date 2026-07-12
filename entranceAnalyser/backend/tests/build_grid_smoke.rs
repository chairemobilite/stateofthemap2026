/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

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
    let Some(db) = common::pg_or_skip().await else {
        return;
    };

    let dir = TempDir::new().unwrap();
    let tif = dir.path().join("synth.tif");

    let pixels: Vec<f32> = vec![
        // upper-left super-cell sums to 4, upper-right to 8,
        // lower-left to 0 (gets dropped), lower-right to 16
        1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 4.0,
    ];
    write_synthetic_geotiff(&tif, &pixels);

    let exe = env!("CARGO_BIN_EXE_entrance-analyser-build-grid");
    let status = Command::new(exe)
        .args([
            "--input",
            tif.to_str().unwrap(),
            "--database-url",
            &db.url,
            "--cell-size-km",
            "2",
            "--epoch",
            "2020",
            "--min-population",
            "0.5",
        ])
        .status()
        .expect("binary runs");
    assert!(status.success(), "build-grid exited with {status}");

    // grid_meta carries exactly one row for our (cell_size_km, epoch) pair.
    // Without --built-volume, the built columns should all be zero.
    let row = sqlx::query(
        "SELECT cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built \
         FROM grid_meta",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i32, _>("cell_size_km"), 2);
    assert_eq!(row.get::<i16, _>("epoch"), 2020);
    assert_eq!(row.get::<f32, _>("max_pop"), 16.0);
    assert_eq!(row.get::<f32, _>("max_built_volume"), 0.0);
    assert_eq!(row.get::<f64, _>("total_pop"), 4.0 + 8.0 + 16.0);
    assert_eq!(row.get::<f64, _>("total_built"), 0.0);

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
async fn build_grid_merges_population_and_built_volume() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };

    let dir = TempDir::new().unwrap();
    let pop_tif = dir.path().join("pop.tif");
    let built_tif = dir.path().join("built.tif");

    // Pop raster: upper-left inhabited (sum 4), lower-right inhabited
    // (sum 16). Upper-right and lower-left are empty (would be dropped
    // by a pop-only build).
    let pop: Vec<f32> = vec![
        1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 4.0,
    ];
    // Built raster: upper-right super-cell has industrial built volume
    // (sum 2000) with zero residents - the "warehouse complex" case the
    // dual-raster path is meant to rescue. Lower-right is mixed
    // (sum 500). Upper-left and lower-left have no built volume.
    let built: Vec<f32> = vec![
        0.0, 0.0, 500.0, 500.0, 0.0, 0.0, 500.0, 500.0, 0.0, 0.0, 125.0, 125.0, 0.0, 0.0, 125.0,
        125.0,
    ];
    write_synthetic_geotiff(&pop_tif, &pop);
    write_synthetic_geotiff(&built_tif, &built);

    let exe = env!("CARGO_BIN_EXE_entrance-analyser-build-grid");
    let status = Command::new(exe)
        .args([
            "--input",
            pop_tif.to_str().unwrap(),
            "--built-volume",
            built_tif.to_str().unwrap(),
            "--database-url",
            &db.url,
            "--cell-size-km",
            "2",
            "--min-population",
            "0.5",
            "--min-built-volume",
            "0.5",
        ])
        .status()
        .expect("binary runs");
    assert!(status.success(), "build-grid exited with {status}");

    // Three super-cells survive: upper-left (pop only), upper-right
    // (built only - the warehouse), lower-right (both). Lower-left has
    // neither signal and must stay dropped.
    let rows = sqlx::query("SELECT pop, built_volume FROM grid_cells ORDER BY pop, built_volume")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    let seen: Vec<(f32, f32)> = rows
        .iter()
        .map(|r| (r.get::<f32, _>("pop"), r.get::<f32, _>("built_volume")))
        .collect();
    assert_eq!(
        seen,
        vec![(0.0, 2000.0), (4.0, 0.0), (16.0, 500.0)],
        "industrial-only cell must survive on the built signal alone",
    );

    let summary =
        sqlx::query("SELECT max_pop, max_built_volume, total_pop, total_built FROM grid_meta")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(summary.get::<f32, _>("max_pop"), 16.0);
    assert_eq!(summary.get::<f32, _>("max_built_volume"), 2000.0);
    assert_eq!(summary.get::<f64, _>("total_pop"), 20.0);
    assert_eq!(summary.get::<f64, _>("total_built"), 2500.0);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn build_grid_rejects_mismatched_raster_shapes() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };

    let dir = TempDir::new().unwrap();
    let pop_tif = dir.path().join("pop.tif");
    let built_tif = dir.path().join("built.tif");
    write_synthetic_geotiff(&pop_tif, &[1.0; 16]);
    // Different shape — build-grid must refuse rather than silently
    // zipping mismatched pixels.
    let mut out = BufWriter::new(File::create(&built_tif).unwrap());
    let mut enc = TiffEncoder::new(&mut out).unwrap();
    let mut img = enc.new_image::<Gray32Float>(2, 2).unwrap();
    img.encoder()
        .write_tag(Tag::ModelPixelScaleTag, &[1000.0_f64, 1000.0, 0.0][..])
        .unwrap();
    img.encoder()
        .write_tag(
            Tag::ModelTiepointTag,
            &[0.0_f64, 0.0, 0.0, -1000.0, 1000.0, 0.0][..],
        )
        .unwrap();
    img.write_data(&[1.0_f32; 4]).unwrap();
    drop(out);

    let exe = env!("CARGO_BIN_EXE_entrance-analyser-build-grid");
    let status = Command::new(exe)
        .args([
            "--input",
            pop_tif.to_str().unwrap(),
            "--built-volume",
            built_tif.to_str().unwrap(),
            "--database-url",
            &db.url,
            "--cell-size-km",
            "2",
        ])
        .status()
        .expect("binary runs");
    assert!(
        !status.success(),
        "build-grid must fail on mismatched rasters"
    );

    db.cleanup().await.ok();
}

#[tokio::test]
async fn build_grid_is_idempotent() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };

    let dir = TempDir::new().unwrap();
    let tif = dir.path().join("synth.tif");
    let pixels: Vec<f32> = vec![
        1.0, 1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 4.0,
    ];
    write_synthetic_geotiff(&tif, &pixels);

    let exe = env!("CARGO_BIN_EXE_entrance-analyser-build-grid");
    for _ in 0..2 {
        let status = Command::new(exe)
            .args([
                "--input",
                tif.to_str().unwrap(),
                "--database-url",
                &db.url,
                "--cell-size-km",
                "2",
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
    assert_eq!(
        meta_count, 1,
        "re-running must not duplicate grid_meta rows"
    );
    assert_eq!(
        cells_count, 3,
        "re-running must replace grid_cells, not append"
    );

    db.cleanup().await.ok();
}

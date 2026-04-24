//! Migration smoke test: bring up a fresh database, apply the embedded
//! migrations, and confirm the expected objects exist.
//!
//! Skipped (with a printed note, not a failure) if no Postgres server
//! is reachable — developers without a running Postgres can still run
//! `cargo test` and the suite stays green. CI always provides one.

mod common;

use rstest::rstest;
use sqlx::Row;

#[rstest]
#[case("grid_meta")]
#[case("grid_cells")]
#[case("kept_bboxes")]
#[case("analyses")]
#[tokio::test]
async fn migration_creates_table(#[case] table: &str) {
    let Some(db) = common::pg_or_skip().await else { return };
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_name = $1)",
    )
    .bind(table)
    .fetch_one(&db.pool)
    .await
    .expect("query succeeds");
    assert!(exists, "table {table} should exist after migrations");
    db.cleanup().await.ok();
}

#[tokio::test]
async fn postgis_extension_is_installed() {
    let Some(db) = common::pg_or_skip().await else { return };
    let row = sqlx::query("SELECT PostGIS_Version() AS v")
        .fetch_one(&db.pool)
        .await
        .expect("PostGIS is available");
    let version: String = row.try_get("v").unwrap();
    assert!(!version.is_empty());
    db.cleanup().await.ok();
}

#[rstest]
#[case("grid_cells", "built_volume")]
#[case("grid_meta",  "total_pop")]
#[case("grid_meta",  "total_built")]
#[case("grid_meta",  "max_built_volume")]
#[tokio::test]
async fn migration_0002_adds_columns(#[case] table: &str, #[case] column: &str) {
    let Some(db) = common::pg_or_skip().await else { return };
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)",
    )
    .bind(table)
    .bind(column)
    .fetch_one(&db.pool)
    .await
    .expect("query succeeds");
    assert!(exists, "column {table}.{column} should exist after migrations");
    db.cleanup().await.ok();
}

#[tokio::test]
async fn grid_cells_geom_column_is_srid_4326_point() {
    let Some(db) = common::pg_or_skip().await else { return };
    let row = sqlx::query(
        "SELECT type, srid FROM geometry_columns \
         WHERE f_table_name = 'grid_cells' AND f_geometry_column = 'geom'",
    )
    .fetch_one(&db.pool)
    .await
    .expect("grid_cells.geom is registered with PostGIS");
    let typ: String = row.try_get("type").unwrap();
    let srid: i32 = row.try_get("srid").unwrap();
    assert_eq!(typ.to_uppercase(), "POINT");
    assert_eq!(srid, 4326);
    db.cleanup().await.ok();
}

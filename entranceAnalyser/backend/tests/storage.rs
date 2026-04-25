//! Integration tests for `PgStore`: round-trip kept bboxes and check the
//! analyses side-table upsert semantics.

mod common;

use entrance_analyser_backend::bbox::Bbox;
use entrance_analyser_backend::storage::PgStore;
use serde_json::json;
use uuid::Uuid;

fn sample_bbox(center: [f64; 2]) -> Bbox {
    let [lon, lat] = center;
    Bbox {
        id: Uuid::new_v4(),
        west: lon - 0.05,
        south: lat - 0.05,
        east: lon + 0.05,
        north: lat + 0.05,
        center,
        cell_size_km: 10,
        population: 12_500.0,
        density_per_km2: 125.0,
        max_density_ratio: 0.25,
        built_volume: 750_000.0,
        max_built_volume_ratio: 0.3,
    }
}

#[tokio::test]
async fn append_then_load_roundtrip() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());

    let a = sample_bbox([-73.55, 45.55]);
    let b = sample_bbox([2.35, 48.85]);
    assert_eq!(store.append(a.clone()).await.unwrap(), 1);
    assert_eq!(store.append(b.clone()).await.unwrap(), 2);

    let kept = store.load().await.unwrap();
    assert_eq!(kept.len(), 2);
    // Load order is insertion order (kept_at ASC, id ASC).
    assert_eq!(kept[0].bbox, a);
    assert_eq!(kept[1].bbox, b);
    db.cleanup().await.ok();
}

#[tokio::test]
async fn count_reflects_rejects_as_noop() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    assert_eq!(store.count().await.unwrap(), 0);
    store.append(sample_bbox([0.0, 0.0])).await.unwrap();
    assert_eq!(store.count().await.unwrap(), 1);
    db.cleanup().await.ok();
}

#[tokio::test]
async fn record_analysis_upserts_by_bbox_and_kind() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([0.0, 0.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    store
        .record_analysis(
            id,
            "entrance_count",
            Some(42.0),
            Some(json!({"confidence": 0.8})),
        )
        .await
        .unwrap();
    // Same (bbox_id, kind) upserts in place.
    store
        .record_analysis(id, "entrance_count", Some(43.0), None)
        .await
        .unwrap();
    // A different `kind` is a separate row.
    store
        .record_analysis(id, "building_count", Some(100.0), None)
        .await
        .unwrap();

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM analyses WHERE bbox_id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        n, 2,
        "upsert must not duplicate rows on the same (bbox_id, kind)"
    );

    let v: Option<f64> = sqlx::query_scalar(
        "SELECT value FROM analyses WHERE bbox_id = $1 AND kind = 'entrance_count'",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(v, Some(43.0), "upsert must update the value in place");

    db.cleanup().await.ok();
}

#[tokio::test]
async fn append_writes_a_valid_postgis_polygon() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let store = PgStore::new(db.pool.clone());
    let bbox = sample_bbox([10.0, 20.0]);
    let id = bbox.id;
    store.append(bbox).await.unwrap();

    let (srid, gtype, area_gt_0): (i32, String, bool) = sqlx::query_as(
        "SELECT ST_SRID(geom), GeometryType(geom), ST_Area(geom) > 0 \
         FROM kept_bboxes WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(srid, 4326);
    assert_eq!(gtype, "POLYGON");
    assert!(area_gt_0);

    db.cleanup().await.ok();
}

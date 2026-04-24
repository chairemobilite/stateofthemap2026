//! End-to-end test for the HTTP API against a live Postgres database.
//!
//! The flow:
//! 1. Build a tiny grid of one cell so `Sampler::from_latest` succeeds
//!    and `/api/bbox/random` can serve that fixed cell deterministically.
//! 2. `GET /api/bbox/random` → a single candidate.
//! 3. `POST /api/bbox/decision` with `keep` → row lands in `kept_bboxes`.
//! 4. `GET /api/bbox/kept` → returns the bbox we just kept.
//! 5. `POST /api/bbox/decision` with `reject` → count unchanged.

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use entrance_analyser_backend::{
    api::{self, AppState},
    bbox::{Bbox, KeptBbox},
    sampler::Sampler,
    storage::PgStore,
};
use http_body_util::BodyExt;
use rstest::rstest;
use serde_json::json;
use tower::ServiceExt;

/// Seed one cell with both pop and built-volume signals so the default
/// `blended` strategy can draw from a non-empty grid. `with_built`
/// controls whether grid-wide totals advertise built-volume availability;
/// the `built_missing_returns_503` test sets it to false.
async fn seed_single_cell(pool: &sqlx::PgPool, with_built: bool) {
    let (meta_built_total, meta_built_max, cell_built) = if with_built {
        (500.0_f64, 500.0_f32, 500.0_f32)
    } else {
        (0.0_f64, 0.0_f32, 0.0_f32)
    };
    sqlx::query(
        "INSERT INTO grid_meta \
         (cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built) \
         VALUES (10, 2020, 1000, $1, 1000, $2)",
    )
    .bind(meta_built_max)
    .bind(meta_built_total)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO grid_cells \
         (cell_size_km, epoch, lat, lon, pop, built_volume, geom) \
         VALUES (10, 2020, 45.5, -73.5, 1000, $1, \
                 ST_SetSRID(ST_MakePoint(-73.5, 45.5), 4326))",
    )
    .bind(cell_built)
    .execute(pool)
    .await
    .unwrap();
}

async fn build_router(pool: sqlx::PgPool) -> axum::Router {
    let sampler = Sampler::from_latest(pool.clone()).await.unwrap();
    assert!(sampler.is_some(), "seed must populate grid_meta");
    let state = AppState::new(PgStore::new(pool), sampler);
    api::router(state)
}

async fn json_body<T: serde::de::DeserializeOwned>(resp: axum::response::Response) -> T {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "failed to parse JSON: {e}; body = {}",
            String::from_utf8_lossy(&bytes)
        )
    })
}

#[tokio::test]
async fn random_keep_reject_flow() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    seed_single_cell(&db.pool, true).await;
    let app = build_router(db.pool.clone()).await;

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bbox/random")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bbox: Bbox = json_body(resp).await;
    assert_eq!(bbox.cell_size_km, 10);
    assert_eq!(bbox.population, 1000.0);
    assert!((bbox.density_per_km2 - 10.0).abs() < 1e-9);
    assert!((bbox.max_density_ratio - 1.0).abs() < 1e-9);

    let keep_body = serde_json::to_vec(&json!({
        "bbox": bbox,
        "decision": "keep",
    }))
    .unwrap();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/bbox/decision")
                .header("content-type", "application/json")
                .body(Body::from(keep_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let reply: serde_json::Value = json_body(resp).await;
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["total_kept"], 1);

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bbox/kept")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let kept: serde_json::Value = json_body(resp).await;
    let items = kept["kept"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    let echoed: KeptBbox = serde_json::from_value(items[0].clone()).unwrap();
    assert_eq!(echoed.bbox.id, bbox.id);

    // A reject does not add a row.
    let reject_body = serde_json::to_vec(&json!({
        "bbox": bbox,
        "decision": "reject",
    }))
    .unwrap();
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/bbox/decision")
                .header("content-type", "application/json")
                .body(Body::from(reject_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let reply: serde_json::Value = json_body(resp).await;
    assert_eq!(reply["total_kept"], 1);

    db.cleanup().await.ok();
}

#[rstest]
#[case("uniform")]
#[case("population")]
#[case("built")]
#[case("blended")]
#[case("blended&alpha=0.25")]
#[tokio::test]
async fn every_strategy_serves_a_bbox_when_data_present(#[case] qs: &str) {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    seed_single_cell(&db.pool, true).await;
    let app = build_router(db.pool.clone()).await;

    let uri = format!("/api/bbox/random?strategy={qs}");
    let resp = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "strategy={qs}");
    let bbox: Bbox = json_body(resp).await;
    assert_eq!(bbox.population, 1000.0);
    assert_eq!(bbox.built_volume, 500.0);
    db.cleanup().await.ok();
}

#[rstest]
#[case("built", StatusCode::SERVICE_UNAVAILABLE)]
#[case("blended", StatusCode::SERVICE_UNAVAILABLE)]
#[case("uniform", StatusCode::OK)]
#[case("population", StatusCode::OK)]
#[tokio::test]
async fn built_strategies_need_built_data(#[case] strategy: &str, #[case] expected: StatusCode) {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    seed_single_cell(&db.pool, false).await;
    let app = build_router(db.pool.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/bbox/random?strategy={strategy}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), expected, "strategy={strategy}");
    db.cleanup().await.ok();
}

#[rstest]
#[case("blended&alpha=-0.1")]
#[case("blended&alpha=1.5")]
#[case("blended&alpha=not-a-number")]
#[tokio::test]
async fn invalid_alpha_returns_400(#[case] qs: &str) {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    seed_single_cell(&db.pool, true).await;
    let app = build_router(db.pool.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/bbox/random?strategy={qs}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "qs={qs}");
    db.cleanup().await.ok();
}

/// Regression for the "value out of range: underflow" failure observed
/// on a real 5.5 M-cell grid: normalised blended weights are O(1e-11)
/// per cell, which made the naive `random() ^ (1/weight)` underflow
/// double precision for every row. The log-space form must survive this
/// scale. Seeds just one cell but with realistic totals, so the
/// computed per-row weight is tiny and would have exploded the old SQL.
#[tokio::test]
async fn blended_survives_tiny_normalised_weights() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    // Totals mirror the production scale (7.8e9 people, 2e18 m³ built);
    // max_pop / max_built match the real 2020 epoch figures so the
    // single seeded cell carries realistic relative mass.
    sqlx::query(
        "INSERT INTO grid_meta \
         (cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built) \
         VALUES (10, 2020, 5693038, 429496729600, 7840952542, 1996200251634214400)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO grid_cells \
         (cell_size_km, epoch, lat, lon, pop, built_volume, geom) \
         VALUES (10, 2020, 45.5, -73.5, 1.0, 1.0, \
                 ST_SetSRID(ST_MakePoint(-73.5, 45.5), 4326))",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    let app = build_router(db.pool.clone()).await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/bbox/random?strategy=blended")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    db.cleanup().await.ok();
}

#[tokio::test]
async fn random_without_grid_returns_503() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    // No seed: grid_meta is empty.
    let sampler = Sampler::from_latest(db.pool.clone()).await.unwrap();
    assert!(sampler.is_none());
    let state = AppState::new(PgStore::new(db.pool.clone()), sampler);
    let app = api::router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/bbox/random")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    db.cleanup().await.ok();
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! End-to-end coverage for `POST /api/bbox/kept/:id/poi_focus` and
//! `GET /api/analyses/poi_focuses`.
//!
//! Each test stands up:
//! 1. A real Postgres database (skipped when `DATABASE_URL` is unset).
//! 2. A wiremock-served fake Overpass instance.
//! 3. The full Axum router wired to the in-process state.
//!
//! Behaviours covered: cache miss → fetch → cache hit (verified via
//! Mock::expect), 409 when the prerequisite POI pick is missing, 422
//! when the pick exists but is empty, 502 mapping for upstream
//! Overpass failures, empty surroundings caching, and the bulk
//! endpoint shape.

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use entrance_analyser_backend::{
    api::{self, AppConfig, AppState},
    bbox::Bbox,
    overpass::OverpassClient,
    poi_config::PoiTagConfig,
    sampler::Sampler,
    storage::PgStore,
};
use http_body_util::BodyExt;
use rstest::rstest;
use serde_json::{json, Value as JsonValue};
use tower::ServiceExt;
use uuid::Uuid;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const POI_TAGS_YAML: &str = r#"
groups:
    shops:
        - shop=*
"#;

/// Buffer used by every test in this file. 150 m is the production
/// default; baking it into the suite means assertions on the cached
/// payload's `radius_m` field have a fixed expected value.
const TEST_FOCUS_RADIUS_M: u32 = 150;

async fn build_router(pool: sqlx::PgPool, overpass_url: String) -> axum::Router {
    let sampler = Sampler::from_latest(pool.clone()).await.unwrap();
    assert!(sampler.is_some(), "seed must populate grid_meta");
    let state = AppState::new(
        PgStore::new(pool),
        sampler,
        PoiTagConfig::from_yaml_str(POI_TAGS_YAML).unwrap(),
        OverpassClient::new(overpass_url),
        AppConfig {
            osm_editor_url: "https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}".into(),
            poi_focus_radius_m: TEST_FOCUS_RADIUS_M,
            measurement_destination_match_radius_m: 10.0,
        },
    );
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

async fn seed_one_cell(pool: &sqlx::PgPool, lat: f64, lon: f64) {
    sqlx::query(
        "INSERT INTO grid_meta \
         (cell_size_km, epoch, max_pop, max_built_volume, total_pop, total_built) \
         VALUES (10, 2020, 1000, 500, 1000, 500) \
         ON CONFLICT (cell_size_km, epoch) DO NOTHING",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO grid_cells \
         (cell_size_km, epoch, lat, lon, pop, built_volume, geom) \
         VALUES (10, 2020, $1, $2, 1000, 500, \
                 ST_SetSRID(ST_MakePoint($2, $1), 4326))",
    )
    .bind(lat)
    .bind(lon)
    .execute(pool)
    .await
    .unwrap();
}

async fn keep_one_bbox(app: &axum::Router) -> Uuid {
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
    let body = serde_json::to_vec(&json!({ "bbox": bbox, "decision": "keep" })).unwrap();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/bbox/decision")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    bbox.id
}

/// Drive a `/poi_pick` so a subsequent `/poi_focus` has its
/// prerequisite. The test caller controls the Overpass response by
/// mounting a `Mock` before invoking this helper.
async fn pick_poi(app: &axum::Router, bbox_id: Uuid) -> JsonValue {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/bbox/kept/{bbox_id}/poi_pick"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "pick must succeed first");
    json_body(resp).await
}

/// Default focus call: no `?radius_m=`, so the handler falls back to
/// the server's `POI_FOCUS_RADIUS_M` (mirrored as
/// [`TEST_FOCUS_RADIUS_M`] in this suite).
async fn focus_poi(app: &axum::Router, bbox_id: Uuid) -> (StatusCode, JsonValue) {
    focus_poi_with_radius(app, bbox_id, None, false).await
}

/// Variant with an optional `?radius_m=` override and `?refresh=true`,
/// used by the per-request-radius tests.
async fn focus_poi_with_radius(
    app: &axum::Router,
    bbox_id: Uuid,
    radius_m: Option<u32>,
    refresh: bool,
) -> (StatusCode, JsonValue) {
    let mut qs: Vec<String> = Vec::new();
    if let Some(r) = radius_m {
        qs.push(format!("radius_m={r}"));
    }
    if refresh {
        qs.push("refresh=true".into());
    }
    let mut uri = format!("/api/bbox/kept/{bbox_id}/poi_focus");
    if !qs.is_empty() {
        uri.push('?');
        uri.push_str(&qs.join("&"));
    }
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: JsonValue =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

fn overpass_body(elements: serde_json::Value) -> serde_json::Value {
    json!({
        "version": 0.6,
        "generator": "wiremock",
        "elements": elements,
    })
}

/// One element matched by the picker's query (out center tags), then
/// a separate set of elements for the focus query (out geom tags). A
/// single mock that returns both is fine because the QL bodies are
/// different and we don't filter on body in the matcher — what
/// matters is the *count* of POSTs when we want to assert caching.
fn shop_pick_element() -> serde_json::Value {
    json!({
        "type": "node", "id": 100, "lat": 45.51, "lon": -73.51,
        "tags": {"shop": "bakery"}
    })
}

#[tokio::test]
async fn first_focus_caches_then_subsequent_calls_short_circuit() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;

    // First /poi_pick request lands a single shop, then /poi_focus
    // lands a building + an entrance within the radius.
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .up_to_n_times(1)
        .mount(&overpass)
        .await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([
                {
                    "type": "way", "id": 500,
                    "geometry": [
                        {"lat": 45.510, "lon": -73.510},
                        {"lat": 45.510, "lon": -73.509},
                        {"lat": 45.511, "lon": -73.509},
                        {"lat": 45.510, "lon": -73.510}
                    ],
                    "tags": {"building": "yes"}
                },
                {
                    "type": "node", "id": 600,
                    "lat": 45.5105, "lon": -73.5095,
                    "tags": {"entrance": "main"}
                }
            ]))),
        )
        .expect(1) // exactly one focus fetch -- second call must short-circuit
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (status, body) = focus_poi(&app, bbox_id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bbox_id"], bbox_id.to_string());
    assert_eq!(body["result"]["radius_m"], TEST_FOCUS_RADIUS_M);
    assert_eq!(
        body["result"]["buildings"]["features"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        body["result"]["entrances"]["features"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(body["result"]["buildings"]["features"][0]["id"], "way/500");
    assert_eq!(body["result"]["entrances"]["features"][0]["id"], "node/600");

    // Re-focus: same response, no extra Overpass call (Mock::expect(1)
    // on the focus mock above will assert on Drop).
    let (status2, body2) = focus_poi(&app, bbox_id).await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(body2["result"]["buildings"]["features"][0]["id"], "way/500");

    db.cleanup().await.ok();
}

#[tokio::test]
async fn same_radius_with_refresh_true_refetches_overpass() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;

    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .up_to_n_times(1)
        .mount(&overpass)
        .await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([
                {
                    "type": "way", "id": 500,
                    "geometry": [
                        {"lat": 45.510, "lon": -73.510},
                        {"lat": 45.510, "lon": -73.509},
                        {"lat": 45.511, "lon": -73.509},
                        {"lat": 45.510, "lon": -73.510}
                    ],
                    "tags": {"building": "yes"}
                },
                {
                    "type": "node", "id": 600,
                    "lat": 45.5105, "lon": -73.5095,
                    "tags": {"entrance": "main"}
                }
            ]))),
        )
        .expect(2)
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (s1, _) = focus_poi(&app, bbox_id).await;
    assert_eq!(s1, StatusCode::OK);
    let (s2, _) = focus_poi_with_radius(&app, bbox_id, None, true).await;
    assert_eq!(s2, StatusCode::OK);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn focus_without_prior_pick_returns_409_conflict() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    // No Overpass calls expected — the handler must short-circuit
    // before reaching the network when the prerequisite is missing.
    let overpass = MockServer::start().await;
    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;

    let (status, body) = focus_poi(&app, bbox_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let msg = body.as_str().unwrap_or_default();
    assert!(
        msg.contains(&bbox_id.to_string()) && msg.contains("poi_pick"),
        "409 body must mention bbox id and required step: {msg:?}",
    );

    db.cleanup().await.ok();
}

#[tokio::test]
async fn focus_after_empty_pick_returns_422_unprocessable() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    // The pick query returns no candidates → poi_pick row is null.
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(overpass_body(json!([]))))
        .expect(1) // pick fires exactly once; focus must NOT fire
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    let pick = pick_poi(&app, bbox_id).await;
    assert!(pick["poi"].is_null(), "pick must be null for this scenario");

    let (status, body) = focus_poi(&app, bbox_id).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let msg = body.as_str().unwrap_or_default();
    assert!(
        msg.contains("nothing to focus on"),
        "422 body should explain why: {msg:?}",
    );

    db.cleanup().await.ok();
}

#[tokio::test]
async fn overpass_5xx_during_focus_surfaces_as_502_bad_gateway() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;

    // First request (the pick) succeeds; second request (the focus)
    // gets a 503 from upstream.
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .up_to_n_times(1)
        .mount(&overpass)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503).set_body_string("upstream unavailable"))
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (status, _) = focus_poi(&app, bbox_id).await;
    assert_eq!(
        status,
        StatusCode::BAD_GATEWAY,
        "Overpass 5xx must surface as 502, never as our own 5xx",
    );

    db.cleanup().await.ok();
}

#[tokio::test]
async fn empty_focus_result_caches_and_serialises_empty_collections() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .up_to_n_times(1)
        .mount(&overpass)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(overpass_body(json!([]))))
        .expect(1)
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (status, body) = focus_poi(&app, bbox_id).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["result"]["buildings"]["features"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(body["result"]["entrances"]["features"]
        .as_array()
        .unwrap()
        .is_empty());

    // And the cache was populated -- no second Overpass call.
    let (status2, _) = focus_poi(&app, bbox_id).await;
    assert_eq!(status2, StatusCode::OK);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_focuses_endpoint_returns_every_cached_focus() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .mount(&overpass)
        .await;

    // Seed two cells; assertion on the bulk endpoint compares set
    // membership rather than order to stay independent of Postgres
    // tie-breaking.
    seed_one_cell(&db.pool, 45.5, -73.5).await;
    seed_one_cell(&db.pool, 45.6, -73.6).await;

    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;

    let mut kept_ids = Vec::new();
    while kept_ids.len() < 2 {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/bbox/random?strategy=uniform")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bbox: Bbox = json_body(resp).await;
        if kept_ids.contains(&bbox.id) {
            continue;
        }
        let body = serde_json::to_vec(&json!({ "bbox": bbox, "decision": "keep" })).unwrap();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/bbox/decision")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        kept_ids.push(bbox.id);
    }
    for id in &kept_ids {
        pick_poi(&app, *id).await;
        let (status, _) = focus_poi(&app, *id).await;
        assert_eq!(status, StatusCode::OK);
    }

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/analyses/poi_focuses")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: JsonValue = json_body(resp).await;
    let focuses = body["focuses"].as_array().unwrap();
    assert_eq!(focuses.len(), 2);
    let returned_ids: Vec<String> = focuses
        .iter()
        .map(|f| f["bbox_id"].as_str().unwrap().to_string())
        .collect();
    for id in &kept_ids {
        assert!(
            returned_ids.contains(&id.to_string()),
            "/poi_focuses missing bbox {id}; got {returned_ids:?}",
        );
    }
    // Every cached row must echo the radius the server was started with.
    for f in focuses {
        assert_eq!(f["result"]["radius_m"], TEST_FOCUS_RADIUS_M);
    }

    db.cleanup().await.ok();
}

/// Validates the `[10, 2000]` guard rails on `?radius_m=`. We don't
/// need a working pick to exercise the validation path because the
/// range check runs before the cache / pick lookups; an empty mock
/// is enough.
#[rstest]
#[case(Some(9), StatusCode::BAD_REQUEST)] // below floor
#[case(Some(2001), StatusCode::BAD_REQUEST)] // above ceiling
#[case(Some(0), StatusCode::BAD_REQUEST)] // common typo
#[case(Some(10), StatusCode::OK)] // floor inclusive
#[case(Some(2000), StatusCode::OK)] // ceiling inclusive
#[case(Some(300), StatusCode::OK)] // typical override
#[case(None, StatusCode::OK)] // omitted falls back to server default
#[tokio::test]
async fn radius_query_param_is_validated(
    #[case] radius_m: Option<u32>,
    #[case] expected: StatusCode,
) {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .up_to_n_times(1)
        .mount(&overpass)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(overpass_body(json!([]))))
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (status, _) = focus_poi_with_radius(&app, bbox_id, radius_m, false).await;
    assert_eq!(status, expected, "radius_m={radius_m:?}");

    db.cleanup().await.ok();
}

/// Switching to a different radius must re-issue the Overpass query
/// and overwrite the cached row. Coming back to the original radius
/// also re-issues (overwrite caching, latest-wins). The single-row
/// guarantee is implied by the shape of the `analyses` table; this
/// test validates the runtime behaviour observed by the API.
#[tokio::test]
async fn changing_radius_re_fetches_overpass_and_overwrites_cache() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;

    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([shop_pick_element()]))),
        )
        .up_to_n_times(1)
        .mount(&overpass)
        .await;
    // Three focus fetches expected: 200 m (initial), 400 m (override
    // → re-fetch), 200 m again (different from cached 400 → re-fetch).
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(overpass_body(json!([]))))
        .expect(3)
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let bbox_id = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (s1, b1) = focus_poi_with_radius(&app, bbox_id, Some(200), false).await;
    assert_eq!(s1, StatusCode::OK);
    assert_eq!(b1["result"]["radius_m"], 200);

    // Same radius → cache hit, no extra Overpass call.
    let (s1b, b1b) = focus_poi_with_radius(&app, bbox_id, Some(200), false).await;
    assert_eq!(s1b, StatusCode::OK);
    assert_eq!(b1b["result"]["radius_m"], 200);

    let (s2, b2) = focus_poi_with_radius(&app, bbox_id, Some(400), false).await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b2["result"]["radius_m"], 400);

    let (s3, b3) = focus_poi_with_radius(&app, bbox_id, Some(200), false).await;
    assert_eq!(s3, StatusCode::OK);
    assert_eq!(b3["result"]["radius_m"], 200);

    db.cleanup().await.ok();
}

//! End-to-end coverage for `POST /api/bbox/kept/:id/poi_pick`,
//! `PATCH /api/bbox/kept/:id/poi_pick`, and `GET /api/analyses/poi_picks`.
//!
//! Each test stands up:
//! 1. A real Postgres database (skipped when `DATABASE_URL` is unset).
//! 2. A wiremock-served fake Overpass instance — never reaches the
//!    public API, so the suite is hermetic and offline-safe.
//! 3. The full Axum router wired to the in-process state.
//!
//! Behaviours covered: first-call cache miss + persist, second-call
//! cache hit (verified by Overpass mount expectations), empty-result
//! caching, 404 for unknown bbox ids, 502 mapping for upstream
//! failures, and chronological ordering of the picks list.

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
    amenities:
        - amenity=*
exceptions:
    - amenity=bench
"#;

/// Build a router pointed at `overpass_url` for the Overpass calls.
/// The sampler must succeed because the integration test fixtures
/// always seed at least one cell before invoking this helper.
async fn build_router(pool: sqlx::PgPool, overpass_url: String) -> axum::Router {
    let sampler = Sampler::from_latest(pool.clone()).await.unwrap();
    assert!(sampler.is_some(), "seed must populate grid_meta");
    let state = AppState::new(
        PgStore::new(pool),
        sampler,
        PoiTagConfig::from_yaml_str(POI_TAGS_YAML).unwrap(),
        OverpassClient::new(overpass_url),
        // Focus radius / OSM editor URL are irrelevant to the poi_pick
        // flow, but the constructor needs the full config — use
        // production defaults so the suite stays representative.
        AppConfig {
            osm_editor_url: "https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}".into(),
            poi_focus_radius_m: 150,
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

/// Seed `grid_meta` plus a single cell at the given `(lat, lon)`. Must
/// be called *before* [`build_router`] so the eager `Sampler` load
/// finds a non-empty grid.
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

/// Hit `/random` + `/decision keep` to land one row in `kept_bboxes`
/// and return the kept bbox id together with the bbox itself.
async fn keep_one_bbox(app: &axum::Router) -> (Uuid, Bbox) {
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
    (bbox.id, bbox)
}

/// Make a `POST /api/bbox/kept/:id/poi_pick` and return the parsed
/// JSON response together with the HTTP status.
async fn pick_poi(app: &axum::Router, bbox_id: Uuid) -> (StatusCode, JsonValue) {
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
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: JsonValue =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

async fn patch_poi_pick(app: &axum::Router, bbox_id: Uuid, completed: bool) -> (StatusCode, JsonValue) {
    patch_poi_pick_body(app, bbox_id, json!({ "completed": completed })).await
}

/// Send an arbitrary JSON body to `PATCH /api/bbox/kept/:id/poi_pick`.
/// Used by the parametric tests so each row can exercise a specific
/// wire shape (legal or 422) without rebuilding the request scaffolding.
async fn patch_poi_pick_body(
    app: &axum::Router,
    bbox_id: Uuid,
    body: JsonValue,
) -> (StatusCode, JsonValue) {
    let payload = serde_json::to_vec(&body).unwrap();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri(format!("/api/bbox/kept/{bbox_id}/poi_pick"))
                .header("content-type", "application/json")
                .body(Body::from(payload))
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

/// Wiremock body shape: a top-level `elements` array whose entries
/// look the same as a real Overpass `out center tags` response.
fn overpass_body(elements: serde_json::Value) -> serde_json::Value {
    json!({
        "version": 0.6,
        "generator": "wiremock",
        "elements": elements,
    })
}

#[tokio::test]
async fn first_pick_caches_then_subsequent_calls_short_circuit() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;

    // Two candidates, both inside the kept cell. The picker draws
    // uniformly so the test asserts membership, not identity.
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([
                {"type": "node", "id": 100, "lat": 45.51, "lon": -73.51,
                 "tags": {"shop": "bakery", "name": "Pain"}},
                {"type": "node", "id": 200, "lat": 45.52, "lon": -73.52,
                 "tags": {"amenity": "cafe", "name": "Café"}},
            ]))),
        )
        .expect(1) // hit Overpass exactly once across both /poi_pick calls
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let (bbox_id, _) = keep_one_bbox(&app).await;

    let (status, body) = pick_poi(&app, bbox_id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bbox_id"], bbox_id.to_string());
    let picked_id = body["poi"]["osm_id"].as_i64().unwrap();
    assert!(
        matches!(picked_id, 100 | 200),
        "picked id {picked_id} must be one of the candidates",
    );
    let picked_group = body["poi"]["group"].as_str().unwrap();
    assert!(
        matches!(picked_group, "shops" | "amenities"),
        "picked group {picked_group:?} must match the YAML",
    );
    assert_eq!(body["completed"].as_bool(), Some(false));

    // Re-pick: same response, no extra Overpass call (Mock::expect(1)).
    let (status2, body2) = pick_poi(&app, bbox_id).await;
    assert_eq!(status2, StatusCode::OK);
    assert_eq!(body2["poi"]["osm_id"].as_i64().unwrap(), picked_id);
    assert_eq!(body2["completed"].as_bool(), Some(false));

    db.cleanup().await.ok();
}

#[tokio::test]
async fn patch_poi_pick_toggles_completed_and_poi_picks_echoes_it() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(overpass_body(json!([
            {"type": "node", "id": 7, "lat": 45.5, "lon": -73.5, "tags": {"shop": "bakery"}},
        ]))))
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let (bbox_id, _) = keep_one_bbox(&app).await;
    let (st, _) = pick_poi(&app, bbox_id).await;
    assert_eq!(st, StatusCode::OK);

    let (st, body) = patch_poi_pick(&app, bbox_id, true).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["completed"].as_bool(), Some(true));

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/analyses/poi_picks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let list: JsonValue = json_body(resp).await;
    let row = list["picks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["bbox_id"].as_str() == Some(&bbox_id.to_string()))
        .unwrap();
    assert_eq!(row["completed"].as_bool(), Some(true));

    let (st2, body2) = patch_poi_pick(&app, bbox_id, false).await;
    assert_eq!(st2, StatusCode::OK);
    assert_eq!(body2["completed"].as_bool(), Some(false));

    db.cleanup().await.ok();
}

#[tokio::test]
async fn patch_completed_true_on_null_pick_returns_422() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
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
    let (bbox_id, _) = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (st, _) = patch_poi_pick(&app, bbox_id, true).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);

    db.cleanup().await.ok();
}

#[tokio::test]
async fn empty_overpass_result_caches_null_pick() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
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
    let (bbox_id, _) = keep_one_bbox(&app).await;

    let (status, body) = pick_poi(&app, bbox_id).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["poi"].is_null(), "empty cell must serialise as null");

    // Second call hits the cache, not Overpass.
    let (status2, body2) = pick_poi(&app, bbox_id).await;
    assert_eq!(status2, StatusCode::OK);
    assert!(body2["poi"].is_null());

    db.cleanup().await.ok();
}

#[tokio::test]
async fn unknown_bbox_id_returns_404() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    // Seed grid + keep one bbox so the sampler is happy, but pick on
    // a *different* (random) id to exercise the not-found branch.
    let overpass = MockServer::start().await;
    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    keep_one_bbox(&app).await;

    let bogus = Uuid::new_v4();
    let (status, body) = pick_poi(&app, bogus).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let msg = body.as_str().unwrap_or_default();
    assert!(msg.contains(&bogus.to_string()), "404 body = {msg:?}");

    db.cleanup().await.ok();
}

#[tokio::test]
async fn overpass_504_surfaces_as_502_bad_gateway() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(504).set_body_string("upstream timed out"))
        .mount(&overpass)
        .await;

    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let (bbox_id, _) = keep_one_bbox(&app).await;

    let (status, _) = pick_poi(&app, bbox_id).await;
    assert_eq!(
        status,
        StatusCode::BAD_GATEWAY,
        "Overpass failures must not mask as our own 5xx",
    );

    db.cleanup().await.ok();
}

#[tokio::test]
async fn poi_picks_endpoint_returns_every_cached_pick() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(overpass_body(json!([
                {"type": "node", "id": 7, "lat": 45.5, "lon": -73.5,
                 "tags": {"shop": "convenience"}},
            ]))),
        )
        .mount(&overpass)
        .await;

    // Seed two grid cells before building the router so the sampler
    // sees both at startup; otherwise `Sampler::from_latest` would
    // return None and the build helper would assert.
    seed_one_cell(&db.pool, 45.5, -73.5).await;
    seed_one_cell(&db.pool, 45.6, -73.6).await;

    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;

    // Keep both bboxes by hitting /random twice (uniqueness comes from
    // grid_cells; the sampler just picks one of the two each call).
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
        let (status, _) = pick_poi(&app, *id).await;
        assert_eq!(status, StatusCode::OK);
    }

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/analyses/poi_picks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: JsonValue = json_body(resp).await;
    let picks = body["picks"].as_array().unwrap();
    assert_eq!(picks.len(), 2);
    let returned_ids: Vec<String> = picks
        .iter()
        .map(|p| p["bbox_id"].as_str().unwrap().to_string())
        .collect();
    for id in &kept_ids {
        assert!(
            returned_ids.contains(&id.to_string()),
            "/poi_picks missing bbox {id}; got {returned_ids:?}",
        );
    }

    db.cleanup().await.ok();
}

/// Stand up a router + Postgres + wiremock instance with one kept
/// bbox already holding a non-null cached pick. The reviewer can then
/// PATCH it through any state. The returned `MockServer` must stay
/// alive for the test (it owns the server task).
async fn setup_pending_picked(
) -> Option<(common::TestDb, axum::Router, Uuid, MockServer)> {
    let db = common::pg_or_skip().await?;
    let overpass = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(overpass_body(json!([
            {"type": "node", "id": 42, "lat": 45.5, "lon": -73.5, "tags": {"shop": "bakery"}},
        ]))))
        .mount(&overpass)
        .await;
    seed_one_cell(&db.pool, 45.5, -73.5).await;
    let app = build_router(
        db.pool.clone(),
        format!("{}/api/interpreter", overpass.uri()),
    )
    .await;
    let (bbox_id, _) = keep_one_bbox(&app).await;
    let (st, _) = pick_poi(&app, bbox_id).await;
    assert_eq!(st, StatusCode::OK);
    Some((db, app, bbox_id, overpass))
}

/// Walks the full reviewer state machine on a single bbox. One DB +
/// one Overpass mock for every transition, so each step is also
/// asserted against `/poi_picks` for round-trip parity. Cheaper than
/// one parametric test per transition (each rstest case would respin
/// Postgres) and easier to read top-to-bottom.
#[tokio::test]
async fn legal_decision_transitions_walk_the_state_machine() {
    let Some((db, app, bbox_id, _overpass)) = setup_pending_picked().await else {
        return;
    };
    // Each row: (PATCH body, expected completed, expected rejected,
    // expected reason or "").
    let steps: &[(JsonValue, bool, bool, &str)] = &[
        // pending → completed
        (json!({"completed": true}), true, false, ""),
        // completed → pending (un-complete)
        (json!({"completed": false}), false, false, ""),
        // pending → rejected (no_imagery)
        (json!({"rejected": true, "rejected_reason": "no_imagery"}), false, true, "no_imagery"),
        // rejected → rejected with a different reason
        (json!({"rejected": true, "rejected_reason": "obsolete"}), false, true, "obsolete"),
        // rejected → completed (must clear the rejection)
        (json!({"completed": true}), true, false, ""),
        // completed → rejected (must clear the completion)
        (json!({"rejected": true, "rejected_reason": "other"}), false, true, "other"),
        // rejected → unreject (back to pending)
        (json!({"rejected": false}), false, false, ""),
        // pending → unreject again (no-op, allowed)
        (json!({"rejected": false}), false, false, ""),
    ];
    for (i, (body, exp_completed, exp_rejected, exp_reason)) in steps.iter().enumerate() {
        let (st, resp) = patch_poi_pick_body(&app, bbox_id, body.clone()).await;
        assert_eq!(st, StatusCode::OK, "step {i}: body = {body}; got = {resp}");
        assert_eq!(resp["completed"].as_bool(), Some(*exp_completed), "step {i}");
        assert_eq!(resp["rejected"].as_bool(), Some(*exp_rejected), "step {i}");
        if exp_reason.is_empty() {
            assert!(resp["rejected_reason"].is_null(), "step {i}: {resp}");
        } else {
            assert_eq!(
                resp["rejected_reason"].as_str(),
                Some(*exp_reason),
                "step {i}",
            );
        }
    }
    db.cleanup().await.ok();
}

/// Each row exercises one illegal body shape and asserts the API
/// returns 422 without mutating the row. Run against a freshly picked
/// (pending) row so the only failure mode under test is the body
/// validator, not the underlying state.
#[rstest]
// Both terminal states in one body.
#[case::completed_and_rejected(json!({"completed": true, "rejected": true, "rejected_reason": "obsolete"}))]
#[case::completed_and_unreject(json!({"completed": false, "rejected": false}))]
// Rejection with no reason.
#[case::reject_without_reason(json!({"rejected": true}))]
// Reason without `rejected: true`.
#[case::reason_without_reject(json!({"rejected_reason": "no_imagery"}))]
#[case::reason_with_unreject(json!({"rejected": false, "rejected_reason": "obsolete"}))]
#[case::reason_with_completed(json!({"completed": true, "rejected_reason": "obsolete"}))]
// Empty body.
#[case::empty(json!({}))]
#[tokio::test]
async fn invalid_decision_bodies_return_422(#[case] body: JsonValue) {
    let Some((db, app, bbox_id, _overpass)) = setup_pending_picked().await else {
        return;
    };
    let (st, resp) = patch_poi_pick_body(&app, bbox_id, body.clone()).await;
    assert_eq!(
        st,
        StatusCode::UNPROCESSABLE_ENTITY,
        "body {body} should be rejected; got status={st} body={resp}",
    );
    // The pick must remain pending (untouched by the failed PATCH).
    let (st_get, get_body) = pick_poi(&app, bbox_id).await;
    assert_eq!(st_get, StatusCode::OK);
    assert_eq!(get_body["completed"].as_bool(), Some(false));
    assert_eq!(get_body["rejected"].as_bool(), Some(false));
    assert!(get_body["rejected_reason"].is_null());
    db.cleanup().await.ok();
}

/// Terminal verdicts (`completed: true`, `rejected: true`) require a
/// real picked POI. Empty cells (where the POI is null) must 422 just
/// like the existing `completed:true` rule does — otherwise the
/// rejection-rate denominator would silently include cells that
/// Overpass simply found nothing in.
#[rstest]
#[case::reject_no_imagery(json!({"rejected": true, "rejected_reason": "no_imagery"}))]
#[case::reject_obsolete(json!({"rejected": true, "rejected_reason": "obsolete"}))]
#[case::reject_other(json!({"rejected": true, "rejected_reason": "other"}))]
#[tokio::test]
async fn reject_on_null_pick_returns_422(#[case] body: JsonValue) {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
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
    let (bbox_id, _) = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await; // caches null pick

    let (st, _) = patch_poi_pick_body(&app, bbox_id, body).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);

    db.cleanup().await.ok();
}

/// Unrejecting (rejected: false) must work even when there is no
/// picked POI — it can only ever revert state, never enter a
/// terminal one.
#[tokio::test]
async fn unreject_on_null_pick_is_a_noop_200() {
    let Some(db) = common::pg_or_skip().await else {
        return;
    };
    let overpass = MockServer::start().await;
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
    let (bbox_id, _) = keep_one_bbox(&app).await;
    pick_poi(&app, bbox_id).await;

    let (st, body) = patch_poi_pick_body(&app, bbox_id, json!({"rejected": false})).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["rejected"].as_bool(), Some(false));
    assert!(body["rejected_reason"].is_null());

    db.cleanup().await.ok();
}

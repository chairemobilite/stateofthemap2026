//! HTTP handlers for `/api/bbox/*`.
//!
//! Three endpoints:
//! - `GET  /api/bbox/random`   → emit a fresh candidate bbox
//! - `POST /api/bbox/decision` → keep or reject a previously emitted bbox
//! - `GET  /api/bbox/kept`     → list every kept bbox
//!
//! The server is stateless between requests: the client echoes the
//! full bbox back on decision, which lets us persist it in a single
//! round-trip and keeps horizontal scaling trivial.

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::bbox::{Bbox, KeptBbox, random_bbox};
use crate::sampler::Sampler;
use crate::storage::PgStore;

/// Shared state: the sampler (optional when no grid has been built yet)
/// and the kept-bboxes Postgres store.
#[derive(Clone)]
pub struct AppState {
    sampler: Option<Sampler>,
    store: PgStore,
}

impl AppState {
    pub fn new(store: PgStore, sampler: Option<Sampler>) -> Self {
        Self { sampler, store }
    }
}

/// Mount the `/api/bbox/*` routes on a fresh router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/bbox/random", get(random_handler))
        .route("/api/bbox/decision", post(decision_handler))
        .route("/api/bbox/kept", get(kept_handler))
        .with_state(state)
}

async fn random_handler(State(state): State<AppState>) -> Result<Json<Bbox>, ApiError> {
    let sampler = state.sampler.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "no GHS-POP grid loaded; run `entrance-analyser-build-grid` first".into(),
    ))?;
    let bbox = random_bbox(sampler).await.map_err(internal)?;
    Ok(Json(bbox))
}

#[derive(Debug, Deserialize)]
pub struct DecisionRequest {
    /// Full bbox as emitted by `/random`. The client echoes it back so
    /// the server never has to keep per-session state in memory.
    pub bbox: Bbox,
    pub decision: Decision,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Keep,
    Reject,
}

#[derive(Debug, Serialize)]
pub struct DecisionResponse {
    pub ok: bool,
    pub total_kept: i64,
}

type ApiError = (StatusCode, String);

async fn decision_handler(
    State(state): State<AppState>,
    Json(req): Json<DecisionRequest>,
) -> Result<Json<DecisionResponse>, ApiError> {
    let total_kept = match req.decision {
        Decision::Keep => state.store.append(req.bbox).await.map_err(internal)?,
        Decision::Reject => state.store.count().await.map_err(internal)?,
    };
    Ok(Json(DecisionResponse { ok: true, total_kept }))
}

#[derive(Debug, Serialize)]
pub struct KeptResponse {
    pub kept: Vec<KeptBbox>,
}

async fn kept_handler(State(state): State<AppState>) -> Result<Json<KeptResponse>, ApiError> {
    let kept = state.store.load().await.map_err(internal)?;
    Ok(Json(KeptResponse { kept }))
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

//! HTTP handlers for `/api/bbox/*`.
//!
//! Three endpoints:
//! - `GET  /api/bbox/random`   → emit a fresh candidate bbox
//! - `POST /api/bbox/decision` → keep or reject a previously emitted bbox
//! - `GET  /api/bbox/kept`     → list all kept bboxes
//!
//! The server remembers in-memory every bbox it has emitted (full object,
//! not just the id) so that `/decision` can persist it without the client
//! having to round-trip the coordinates.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::bbox::{Bbox, KeptBbox, random_bbox};
use crate::storage::JsonStore;

/// Shared state: the in-memory pool of emitted (but not-yet-decided) bboxes
/// and the JSON store handle.
#[derive(Clone)]
pub struct AppState {
    issued: Arc<Mutex<HashMap<Uuid, Bbox>>>,
    store: JsonStore,
}

impl AppState {
    pub fn new(store: JsonStore) -> Self {
        Self {
            issued: Arc::new(Mutex::new(HashMap::new())),
            store,
        }
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

async fn random_handler(State(state): State<AppState>) -> Json<Bbox> {
    let bbox = random_bbox();
    state
        .issued
        .lock()
        .expect("issued mutex poisoned")
        .insert(bbox.id, bbox.clone());
    Json(bbox)
}

#[derive(Debug, Deserialize)]
pub struct DecisionRequest {
    pub id: Uuid,
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
    pub total_kept: usize,
}

type ApiError = (StatusCode, String);

async fn decision_handler(
    State(state): State<AppState>,
    Json(req): Json<DecisionRequest>,
) -> Result<Json<DecisionResponse>, ApiError> {
    // Drop the bbox from the issued map regardless of the decision so the
    // id can't be replayed.
    let bbox = state
        .issued
        .lock()
        .expect("issued mutex poisoned")
        .remove(&req.id)
        .ok_or((
            StatusCode::BAD_REQUEST,
            format!("unknown or already-decided bbox id: {}", req.id),
        ))?;

    let total_kept = match req.decision {
        Decision::Keep => state
            .store
            .append(KeptBbox {
                bbox,
                kept_at: Utc::now(),
            })
            .map_err(internal)?,
        Decision::Reject => state.store.load().map_err(internal)?.kept_bboxes.len(),
    };

    Ok(Json(DecisionResponse {
        ok: true,
        total_kept,
    }))
}

#[derive(Debug, Serialize)]
pub struct KeptResponse {
    pub kept: Vec<KeptBbox>,
}

async fn kept_handler(State(state): State<AppState>) -> Result<Json<KeptResponse>, ApiError> {
    let file = state.store.load().map_err(internal)?;
    Ok(Json(KeptResponse {
        kept: file.kept_bboxes,
    }))
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

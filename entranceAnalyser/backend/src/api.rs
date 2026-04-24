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
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::bbox::{Bbox, KeptBbox, random_bbox};
use crate::sampler::{SampleError, Sampler, Strategy};
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

/// `?strategy=uniform|population|built|blended` and optional
/// `?alpha=0.0..=1.0` (only consulted when `strategy=blended`). Defaults
/// to `blended` with α=0.5, which is the recommended per-draw mix.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub struct RandomQuery {
    pub strategy: Option<StrategyName>,
    pub alpha: Option<f64>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StrategyName {
    Uniform,
    Population,
    Built,
    Blended,
}

impl RandomQuery {
    /// Resolve the query parameters into a concrete [`Strategy`], or an
    /// HTTP 400 error when `alpha` is outside `[0, 1]`.
    fn into_strategy(self) -> Result<Strategy, ApiError> {
        let name = self.strategy.unwrap_or(StrategyName::Blended);
        let strategy = match name {
            StrategyName::Uniform => Strategy::Uniform,
            StrategyName::Population => Strategy::Population,
            StrategyName::Built => Strategy::Built,
            StrategyName::Blended => {
                let alpha = self.alpha.unwrap_or(Strategy::DEFAULT_ALPHA);
                if !(0.0..=1.0).contains(&alpha) {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("alpha must be in [0, 1], got {alpha}"),
                    ));
                }
                Strategy::Blended { alpha }
            }
        };
        Ok(strategy)
    }
}

async fn random_handler(
    State(state): State<AppState>,
    Query(query): Query<RandomQuery>,
) -> Result<Json<Bbox>, ApiError> {
    let sampler = state.sampler.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "no GHS-POP grid loaded; run `entrance-analyser-build-grid` first".into(),
    ))?;
    let strategy = query.into_strategy()?;
    let bbox = random_bbox(sampler, strategy).await.map_err(sample_error)?;
    Ok(Json(bbox))
}

fn sample_error(err: SampleError) -> ApiError {
    match err {
        SampleError::BuiltUnavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "this strategy needs GHS-BUILT-V data; rerun \
             `entrance-analyser-build-grid --built-volume <path>` to enable it"
                .into(),
        ),
        SampleError::Db(e) => internal(e),
    }
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

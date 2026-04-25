//! HTTP handlers for `/api/*`.
//!
//! Endpoints:
//! - `GET  /api/bbox/random`                 → emit a fresh candidate bbox
//! - `POST /api/bbox/decision`               → keep or reject a previously emitted bbox
//! - `GET  /api/bbox/kept`                   → list every kept bbox
//! - `POST /api/bbox/kept/:id/poi_pick`      → pick (and cache) one POI in a kept cell
//! - `GET  /api/analyses/poi_picks`          → every cached POI pick, by bbox id
//!
//! The server is stateless between requests: the client echoes the
//! full bbox back on decision, which lets us persist it in a single
//! round-trip and keeps horizontal scaling trivial.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use rand::seq::IteratorRandom;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::bbox::{random_bbox, Bbox, KeptBbox};
use crate::overpass::{OverpassClient, OverpassError, Poi};
use crate::poi_config::PoiTagConfig;
use crate::sampler::{SampleError, Sampler, Strategy};
use crate::storage::PgStore;

/// Shared state: the sampler (optional when no grid has been built
/// yet), the kept-bboxes Postgres store, the parsed POI tag config,
/// and the Overpass HTTP client.
///
/// `poi_config` is wrapped in `Arc` so per-request `State` clones stay
/// cheap; `PgStore` and `OverpassClient` already hold internal `Arc`s
/// (their `pool` / `reqwest::Client`) so cloning them is also cheap.
#[derive(Clone)]
pub struct AppState {
    sampler: Option<Sampler>,
    store: PgStore,
    poi_config: Arc<PoiTagConfig>,
    overpass: OverpassClient,
}

impl AppState {
    pub fn new(
        store: PgStore,
        sampler: Option<Sampler>,
        poi_config: PoiTagConfig,
        overpass: OverpassClient,
    ) -> Self {
        Self {
            sampler,
            store,
            poi_config: Arc::new(poi_config),
            overpass,
        }
    }
}

/// Mount every public `/api/*` route on a fresh router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/bbox/random", get(random_handler))
        .route("/api/bbox/decision", post(decision_handler))
        .route("/api/bbox/kept", get(kept_handler))
        .route("/api/bbox/kept/:id/poi_pick", post(poi_pick_handler))
        .route("/api/analyses/poi_picks", get(poi_picks_handler))
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
    let kept = state.store.load().await.map_err(internal)?;
    Ok(Json(KeptResponse { kept }))
}

/// One picked POI for a given bbox. `poi` is `null` when Overpass
/// returned no matching feature for the cell — distinct from "we
/// haven't picked yet", which would not appear in `/poi_picks` at all.
#[derive(Debug, Serialize)]
pub struct PoiPickResponse {
    pub bbox_id: Uuid,
    pub poi: Option<Poi>,
}

async fn poi_pick_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
) -> Result<Json<PoiPickResponse>, ApiError> {
    // Cache hit: return the previously-picked POI (or the cached
    // "empty cell" verdict). Idempotent by design — repeated clicks of
    // the Pick POI button never re-roll the choice.
    if let Some(cached) = state.store.read_poi_pick(bbox_id).await.map_err(internal)? {
        return Ok(Json(PoiPickResponse {
            bbox_id,
            poi: cached,
        }));
    }
    // Fresh pick: load the bbox so we can bound the Overpass query.
    let kept = state
        .store
        .get_kept(bbox_id)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("kept bbox {bbox_id} not found"),
        ))?;
    let candidates = state
        .overpass
        .fetch_pois(&kept.bbox, &state.poi_config)
        .await
        .map_err(overpass_error)?;
    // Uniform draw across every candidate (regardless of group), per
    // the locked decision for PR8: one POI total per cell.
    let chosen = candidates.into_iter().choose(&mut rand::rng());
    state
        .store
        .write_poi_pick(bbox_id, chosen.as_ref())
        .await
        .map_err(internal)?;
    Ok(Json(PoiPickResponse {
        bbox_id,
        poi: chosen,
    }))
}

#[derive(Debug, Serialize)]
pub struct PoiPicksResponse {
    pub picks: Vec<PoiPickResponse>,
}

async fn poi_picks_handler(
    State(state): State<AppState>,
) -> Result<Json<PoiPicksResponse>, ApiError> {
    let raw = state.store.read_all_poi_picks().await.map_err(internal)?;
    let picks = raw
        .into_iter()
        .map(|(bbox_id, poi)| PoiPickResponse { bbox_id, poi })
        .collect();
    Ok(Json(PoiPicksResponse { picks }))
}

/// Map any Overpass-side failure to HTTP 502. We deliberately do not
/// forward the upstream status code — a 401/403/429 from Overpass is
/// not a 401/403/429 from *us* and propagating it would mislead the
/// caller about which service is unhealthy.
fn overpass_error(err: OverpassError) -> ApiError {
    (StatusCode::BAD_GATEWAY, format!("overpass: {err}"))
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! HTTP handlers for `/api/*`.
//!
//! Endpoints:
//! - `GET  /api/config`                      → public-facing runtime config (URL templates, radii)
//! - `GET  /api/bbox/random`                 → emit a fresh candidate bbox
//! - `POST /api/bbox/custom_centroid`        → bbox centred on lat/lon (stats from nearest grid cell)
//! - `POST /api/bbox/custom_osm`             → bbox centred on one OSM node/way/relation (`out center`)
//! - `POST /api/bbox/decision`               → keep or reject a previously emitted bbox
//! - `GET  /api/bbox/kept`                   → list every kept bbox
//! - `DELETE /api/bbox/kept/:id`             → remove one kept bbox (cascades analyses + measurements)
//! - `POST /api/bbox/kept/:id/poi_pick`      → pick (and cache) one POI in a kept cell
//! - `PATCH /api/bbox/kept/:id/poi_pick`     → flip reviewer state (`completed` / `rejected`+reason / unreject)
//! - `GET  /api/analyses/poi_picks`          → every cached POI pick, by bbox id
//! - `POST /api/bbox/kept/:id/poi_focus`     → fetch (and cache) buildings + entrances around the picked POI
//!   (optional `?radius_m=N` & `?refresh=true`; radius defaults to `POI_FOCUS_RADIUS_M`; refresh bypasses cache)
//! - `GET  /api/analyses/poi_focuses`        → every cached focus result, by bbox id
//! - `GET  /api/bbox/kept/:id/poi_focus_measurements` → list persisted measure polylines
//! - `POST /api/bbox/kept/:id/poi_focus_measurements` → create one polyline
//! - `PATCH /api/bbox/kept/:id/poi_focus_measurements/:measure_id` → update geometry + speed
//! - `DELETE /api/bbox/kept/:id/poi_focus_measurements/:measure_id` → remove one row
//! - `GET  /api/analyses/poi_focus_measurement_stats` → min/max/avg/median length and duration by attribute pairs
//! - `GET  /api/analyses/poi_focus_measurement_destination_warnings` → per-POI destination mismatch warnings
//! - `GET  /api/analyses/poi_pick_country_stats` → POI counts per country (+ Quebec subset) via PostGIS
//!
//! The server is stateless between requests: the client echoes the
//! full bbox back on decision, which lets us persist it in a single
//! round-trip and keeps horizontal scaling trivial.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, patch, post},
    Json, Router,
};
use rand::seq::IteratorRandom;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::bbox::{bbox_from_cell, random_bbox, Bbox, CandidateSource, KeptBbox};
use crate::focus_measurements::{
    path_length_m_haversine, validate_coordinates, validate_measurement_start_for_write,
    validate_walking_speed_kmh, PoiFocusMeasurement, PoiFocusMeasurementStats,
    PoiFocusMeasurementUpsertBody,
};
use crate::measurement_destination_warnings::PoiFocusMeasurementDestinationWarningsResponse;
use crate::overpass::{parse_osm_ref, OverpassClient, OverpassError, OsmType, Poi};
use crate::poi_config::PoiTagConfig;
use crate::poi_focus::{fetch_focus, PoiFocusResult};
use crate::sampler::{SampleError, Sampler, Strategy};
use crate::storage::{PgStore, PoiPickCountryStats, PoiRejectionReason};

/// Public-facing runtime config exposed to the frontend via
/// `GET /api/config`. Everything in here is safe to ship to clients —
/// no secrets, no DB URLs, just URL templates and tuning knobs the UI
/// needs in order to render correctly.
///
/// The struct doubles as the wire shape for the endpoint, so adding a
/// field here automatically extends the JSON response. `serde`'s
/// `rename_all = "snake_case"` keeps the wire keys consistent with the
/// rest of the API even though Rust field names already are.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AppConfig {
    /// URL template the frontend uses to open the OSM editor at a
    /// clicked map location. Supports `{lat}` / `{lon}` / `{zoom}`
    /// placeholders, mirroring the `{z}/{x}/{y}` raster-tile
    /// convention already used in `frontend/src/basemaps.ts`.
    pub osm_editor_url: String,
    /// `around:` buffer (m) used by the `/poi_focus` endpoint. Echoed
    /// here so the UI can show the active default before the first
    /// focus map is fetched.
    pub poi_focus_radius_m: u32,
    /// Endpoint match tolerance (m) for destination-mismatch warnings
    /// on the focus map and `GET …/poi_focus_measurement_destination_warnings`.
    pub measurement_destination_match_radius_m: f64,
}

/// Shared state: the sampler (optional when no grid has been built
/// yet), the kept-bboxes Postgres store, the parsed POI tag config,
/// the Overpass HTTP client, and the public runtime config.
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
    config: AppConfig,
}

impl AppState {
    pub fn new(
        store: PgStore,
        sampler: Option<Sampler>,
        poi_config: PoiTagConfig,
        overpass: OverpassClient,
        config: AppConfig,
    ) -> Self {
        Self {
            sampler,
            store,
            poi_config: Arc::new(poi_config),
            overpass,
            config,
        }
    }
}

/// Mount every public `/api/*` route on a fresh router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/config", get(config_handler))
        .route("/api/bbox/random", get(random_handler))
        .route("/api/bbox/custom_centroid", post(custom_centroid_handler))
        .route("/api/bbox/custom_osm", post(custom_osm_handler))
        .route("/api/bbox/decision", post(decision_handler))
        .route("/api/bbox/kept", get(kept_handler))
        .route("/api/bbox/kept/:id", delete(delete_kept_handler))
        .route(
            "/api/bbox/kept/:id/poi_pick",
            post(poi_pick_handler).patch(patch_poi_pick_handler),
        )
        .route("/api/analyses/poi_picks", get(poi_picks_handler))
        .route("/api/bbox/kept/:id/poi_focus", post(poi_focus_handler))
        .route(
            "/api/bbox/kept/:id/poi_focus_measurements",
            get(poi_focus_measurements_list_handler).post(poi_focus_measurements_create_handler),
        )
        .route(
            "/api/bbox/kept/:id/poi_focus_measurements/:measure_id",
            patch(poi_focus_measurements_update_handler).delete(poi_focus_measurements_delete_handler),
        )
        .route("/api/analyses/poi_focuses", get(poi_focuses_handler))
        .route(
            "/api/analyses/poi_focus_measurement_stats",
            get(poi_focus_measurement_stats_handler),
        )
        .route(
            "/api/analyses/poi_focus_measurement_destination_warnings",
            get(poi_focus_measurement_destination_warnings_handler),
        )
        .route(
            "/api/analyses/poi_pick_country_stats",
            get(poi_pick_country_stats_handler),
        )
        .with_state(state)
}

/// `GET /api/config` — publish the public-facing runtime config.
/// Cheap clone (the config is plain `String` + `u32`); called once
/// per page load by the frontend.
async fn config_handler(State(state): State<AppState>) -> Json<AppConfig> {
    Json(state.config.clone())
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
        SampleError::EmptyGrid => (
            StatusCode::SERVICE_UNAVAILABLE,
            "no grid cells for the active build; run `entrance-analyser-build-grid` first".into(),
        ),
        SampleError::Db(e) => internal(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct CustomCentroidBody {
    pub lat: f64,
    pub lon: f64,
}

async fn custom_centroid_handler(
    State(state): State<AppState>,
    Json(body): Json<CustomCentroidBody>,
) -> Result<Json<Bbox>, ApiError> {
    if !body.lat.is_finite() || !body.lon.is_finite() {
        return Err((
            StatusCode::BAD_REQUEST,
            "lat and lon must be finite numbers".into(),
        ));
    }
    if !(-90.0..=90.0).contains(&body.lat) {
        return Err((StatusCode::BAD_REQUEST, "lat must be in [-90, 90]".into()));
    }
    if !(-180.0..=180.0).contains(&body.lon) {
        return Err((StatusCode::BAD_REQUEST, "lon must be in [-180, 180]".into()));
    }
    let sampler = state.sampler.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "no GHS-POP grid loaded; run `entrance-analyser-build-grid` first".into(),
    ))?;
    let cell = sampler
        .sampled_cell_at_centroid(body.lon, body.lat)
        .await
        .map_err(sample_error)?;
    Ok(Json(bbox_from_cell(
        cell,
        sampler.cell_size_km(),
        CandidateSource::CustomCentroid,
    )))
}

#[derive(Debug, Deserialize)]
pub struct CustomOsmBody {
    /// `node/123`, `way/456`, or `relation/789` (spaces optional).
    pub osm_ref: String,
}

async fn custom_osm_handler(
    State(state): State<AppState>,
    Json(body): Json<CustomOsmBody>,
) -> Result<Json<Bbox>, ApiError> {
    let (osm_type, id) = parse_osm_ref(&body.osm_ref).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let (center, _) = state
        .overpass
        .fetch_osm_anchor_center(osm_type, id)
        .await
        .map_err(overpass_error)?;
    let sampler = state.sampler.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "no GHS-POP grid loaded; run `entrance-analyser-build-grid` first".into(),
    ))?;
    let cell = sampler
        .sampled_cell_at_centroid(center[0], center[1])
        .await
        .map_err(sample_error)?;
    let mut bbox = bbox_from_cell(
        cell,
        sampler.cell_size_km(),
        CandidateSource::CustomOsm,
    );
    bbox.custom_osm_type = Some(osm_type.as_str().to_string());
    bbox.custom_osm_id = Some(id);
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
        Decision::Keep => {
            if req.bbox.candidate_source == CandidateSource::CustomOsm
                && (req.bbox.custom_osm_type.is_none() || req.bbox.custom_osm_id.is_none())
            {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "custom_osm bbox must include custom_osm_type and custom_osm_id".into(),
                ));
            }
            let total_kept = state.store.append(req.bbox.clone()).await.map_err(internal)?;
            if matches!(
                req.bbox.candidate_source,
                CandidateSource::CustomCentroid | CandidateSource::CustomOsm
            ) {
                let poi = match req.bbox.candidate_source {
                    CandidateSource::CustomCentroid => synthetic_centroid_poi(&req.bbox),
                    CandidateSource::CustomOsm => {
                        let mut poi = custom_osm_anchor_poi(&req.bbox)
                            .map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;
                        // Fetch the object's tags so the pick can be
                        // classified (place-type stats, UI labels). Best
                        // effort: an Overpass hiccup must not block the
                        // keep, it only leaves the tags empty.
                        match state
                            .overpass
                            .fetch_osm_anchor_center(poi.osm_type, poi.osm_id)
                            .await
                        {
                            Ok((_, tags)) => {
                                if let Some(group) = state.poi_config.group_for_tags(&tags) {
                                    poi.group = group.to_string();
                                }
                                poi.tags = tags;
                            }
                            Err(err) => eprintln!(
                                "warning: keeping custom OSM pick without tags (overpass: {err})"
                            ),
                        }
                        poi
                    }
                    CandidateSource::Random => unreachable!(),
                };
                state
                    .store
                    .write_poi_pick(req.bbox.id, Some(&poi))
                    .await
                    .map_err(internal)?;
            }
            total_kept
        }
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

async fn delete_kept_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let removed = state
        .store
        .remove_kept(bbox_id)
        .await
        .map_err(internal)?;
    if !removed {
        return Err((
            StatusCode::NOT_FOUND,
            format!("kept bbox {bbox_id} not found"),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// One picked POI for a given bbox. `poi` is `null` when Overpass
/// returned no matching feature for the cell — distinct from "we
/// haven't picked yet", which would not appear in `/poi_picks` at all.
///
/// `completed` and `rejected` are the two terminal reviewer states
/// (mutually exclusive); when both are `false` the row is "pending".
/// `rejected_reason` is `Some` iff `rejected` is `true`.
#[derive(Debug, Serialize)]
pub struct PoiPickResponse {
    pub bbox_id: Uuid,
    pub poi: Option<Poi>,
    /// Reviewer flag: POI analysis marked done on the overview map (green dot).
    pub completed: bool,
    /// Reviewer flag: POI dropped from the analysis (e.g. no imagery,
    /// obsolete tag). Counted in the rejection-rate denominator.
    pub rejected: bool,
    pub rejected_reason: Option<PoiRejectionReason>,
}

/// Wire body for `PATCH /api/bbox/kept/:id/poi_pick`. The handler
/// turns this loose shape into an internal [`PoiPickDecision`] and
/// 422s on every invalid combination — see [`PatchPoiPickBody::decision`].
///
/// All fields are optional so existing clients that still send
/// `{ "completed": true|false }` keep working unchanged.
#[derive(Debug, Deserialize)]
pub struct PatchPoiPickBody {
    pub completed: Option<bool>,
    pub rejected: Option<bool>,
    pub rejected_reason: Option<PoiRejectionReason>,
}

/// One reviewer transition. The handler only mutates the row along
/// one of these three paths per request, which keeps the audit story
/// (and the 422 surface) trivially small.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PoiPickDecision {
    /// Set or clear the `completed` flag (clears any rejection on `true`).
    Completed(bool),
    /// Reject the pick with a structured reason (clears `completed`).
    Reject(PoiRejectionReason),
    /// Move a previously rejected pick back to pending (does not touch `completed`).
    Unreject,
}

impl PatchPoiPickBody {
    /// Validate the wire body and project it to a single decision.
    /// Returns the 422 message verbatim so the handler can shape the
    /// response without re-deriving the rule.
    fn decision(&self) -> Result<PoiPickDecision, &'static str> {
        // The order of these arms matters: each accepted shape is
        // matched exactly first, then the more permissive 422 patterns
        // catch every remaining inconsistent combination.
        match (self.completed, self.rejected, self.rejected_reason) {
            (Some(c), None, None) => Ok(PoiPickDecision::Completed(c)),
            (None, Some(true), Some(reason)) => Ok(PoiPickDecision::Reject(reason)),
            (None, Some(false), None) => Ok(PoiPickDecision::Unreject),

            (None, Some(true), None) => Err("`rejected: true` requires `rejected_reason`"),
            (Some(_), Some(_), _) => {
                Err("`completed` and `rejected` cannot be set in the same request")
            }
            (_, _, Some(_)) => Err("`rejected_reason` is only valid with `rejected: true`"),
            (None, None, None) => Err(
                "body must set one of `completed`, `rejected: true` (with `rejected_reason`), or `rejected: false`",
            ),
        }
    }
}

async fn poi_pick_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
) -> Result<Json<PoiPickResponse>, ApiError> {
    // Cache hit: return the previously-picked POI (or the cached
    // "empty cell" verdict). Idempotent by design — repeated clicks of
    // the Pick POI button never re-roll the choice.
    if let Some(cached) = state
        .store
        .read_poi_pick_payload(bbox_id)
        .await
        .map_err(internal)?
    {
        return Ok(Json(PoiPickResponse {
            bbox_id,
            poi: cached.poi,
            completed: cached.completed,
            rejected: cached.rejected,
            rejected_reason: cached.rejected_reason,
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
    let chosen = match kept.bbox.candidate_source {
        CandidateSource::CustomCentroid => Some(synthetic_centroid_poi(&kept.bbox)),
        CandidateSource::CustomOsm => Some(
            custom_osm_anchor_poi(&kept.bbox).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?,
        ),
        CandidateSource::Random => {
            let candidates = state
                .overpass
                .fetch_pois(&kept.bbox, &state.poi_config)
                .await
                .map_err(overpass_error)?;
            // Uniform draw across every candidate (regardless of group), per
            // the locked decision for PR8: one POI total per cell.
            candidates.into_iter().choose(&mut rand::rng())
        }
    };
    state
        .store
        .write_poi_pick(bbox_id, chosen.as_ref())
        .await
        .map_err(internal)?;
    Ok(Json(PoiPickResponse {
        bbox_id,
        poi: chosen,
        completed: false,
        rejected: false,
        rejected_reason: None,
    }))
}

async fn patch_poi_pick_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
    Json(body): Json<PatchPoiPickBody>,
) -> Result<Json<PoiPickResponse>, ApiError> {
    let decision = body
        .decision()
        .map_err(|msg| (StatusCode::UNPROCESSABLE_ENTITY, msg.to_string()))?;

    // Pre-flight: terminal states (completed=true / rejected=true)
    // require a real picked POI. Reading the row first surfaces the
    // 404 / 422 cases without a wasted UPDATE round-trip.
    let current = state
        .store
        .read_poi_pick_payload(bbox_id)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("bbox {bbox_id} has no POI pick row — run POST /poi_pick first"),
        ))?;
    let needs_picked_poi = matches!(
        decision,
        PoiPickDecision::Completed(true) | PoiPickDecision::Reject(_)
    );
    if needs_picked_poi && current.poi.is_none() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "cannot mark completed or rejected when this cell has no picked POI (empty pick)"
                .to_string(),
        ));
    }

    let payload = match decision {
        PoiPickDecision::Completed(value) => state
            .store
            .set_poi_pick_completed(bbox_id, value)
            .await
            .map_err(internal)?,
        PoiPickDecision::Reject(reason) => state
            .store
            .set_poi_pick_rejection(bbox_id, Some(reason))
            .await
            .map_err(internal)?,
        PoiPickDecision::Unreject => state
            .store
            .set_poi_pick_rejection(bbox_id, None)
            .await
            .map_err(internal)?,
    };
    // The pre-flight read already proved the row exists; an Ok(None)
    // here would only happen on a concurrent delete, which we surface
    // as 404 rather than 500.
    let payload = payload.ok_or((
        StatusCode::NOT_FOUND,
        format!("bbox {bbox_id} POI pick row vanished mid-update"),
    ))?;
    Ok(Json(PoiPickResponse {
        bbox_id,
        poi: payload.poi,
        completed: payload.completed,
        rejected: payload.rejected,
        rejected_reason: payload.rejected_reason,
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
        .map(|(bbox_id, p)| PoiPickResponse {
            bbox_id,
            poi: p.poi,
            completed: p.completed,
            rejected: p.rejected,
            rejected_reason: p.rejected_reason,
        })
        .collect();
    Ok(Json(PoiPicksResponse { picks }))
}

/// One focus result for a given bbox. The `result` field is always
/// populated when present; an empty area is encoded as empty
/// FeatureCollections inside [`PoiFocusResult`], not by omitting the
/// row.
#[derive(Debug, Serialize)]
pub struct PoiFocusResponse {
    pub bbox_id: Uuid,
    pub result: PoiFocusResult,
}

/// Optional overrides for `POST /poi_focus`. The buffer radius can
/// be tweaked per-request; an unset value falls back to the
/// server-side `POI_FOCUS_RADIUS_M`. `refresh=true` skips the
/// per-bbox row cache so Overpass is queried again at the same radius
/// (for example after OSM edits).
#[derive(Debug, Deserialize, Default)]
pub struct PoiFocusParams {
    pub radius_m: Option<u32>,
    #[serde(default)]
    pub refresh: bool,
}

/// Hard guard rails on the buffer size. Below 10 m the `around:`
/// filter loses any usefulness; above 2000 m the Overpass query
/// budget (25 s) is at risk of timing out in dense urban areas. The
/// frontend `<input min/max>` mirrors these — keep them in sync.
pub const POI_FOCUS_RADIUS_MIN_M: u32 = 10;
pub const POI_FOCUS_RADIUS_MAX_M: u32 = 2000;

async fn poi_focus_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
    Query(params): Query<PoiFocusParams>,
) -> Result<Json<PoiFocusResponse>, ApiError> {
    let effective_radius_m = params.radius_m.unwrap_or(state.config.poi_focus_radius_m);
    if !(POI_FOCUS_RADIUS_MIN_M..=POI_FOCUS_RADIUS_MAX_M).contains(&effective_radius_m) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "radius_m must be in [{POI_FOCUS_RADIUS_MIN_M}, {POI_FOCUS_RADIUS_MAX_M}], got {effective_radius_m}",
            ),
        ));
    }

    // Cache hit ONLY when the cached result was computed at the same
    // radius as the current request and the client did not ask for a
    // refresh. A different radius means the buffer changed and the
    // buildings/entrances inside it almost certainly differ; we
    // re-fetch and overwrite the cache so the single row per bbox
    // always reflects the latest user choice.
    if !params.refresh {
        if let Some(cached) = state
            .store
            .read_poi_focus(bbox_id)
            .await
            .map_err(internal)?
        {
            if cached.radius_m == effective_radius_m {
                return Ok(Json(PoiFocusResponse {
                    bbox_id,
                    result: cached,
                }));
            }
        }
    }
    // Focus map is anchored on the previously-picked POI; require
    // that step to have run first, with a non-null pick.
    let pick = state
        .store
        .read_poi_pick(bbox_id)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::CONFLICT,
            format!("bbox {bbox_id} has no POI pick yet — run /poi_pick first"),
        ))?;
    let pick = pick.ok_or((
        StatusCode::UNPROCESSABLE_ENTITY,
        format!("bbox {bbox_id} was picked but contained no POI — nothing to focus on"),
    ))?;
    let result = fetch_focus(&state.overpass, pick.center, effective_radius_m)
        .await
        .map_err(overpass_error)?;
    state
        .store
        .write_poi_focus(bbox_id, &result)
        .await
        .map_err(internal)?;
    Ok(Json(PoiFocusResponse { bbox_id, result }))
}

#[derive(Debug, Serialize)]
pub struct PoiFocusesResponse {
    pub focuses: Vec<PoiFocusResponse>,
}

async fn poi_focuses_handler(
    State(state): State<AppState>,
) -> Result<Json<PoiFocusesResponse>, ApiError> {
    let raw = state.store.read_all_poi_focuses().await.map_err(internal)?;
    let focuses = raw
        .into_iter()
        .map(|(bbox_id, result)| PoiFocusResponse { bbox_id, result })
        .collect();
    Ok(Json(PoiFocusesResponse { focuses }))
}

async fn poi_focus_measurement_stats_handler(
    State(state): State<AppState>,
) -> Result<Json<PoiFocusMeasurementStats>, ApiError> {
    let stats = state
        .store
        .aggregate_poi_focus_measurement_pair_stats(
            state.config.measurement_destination_match_radius_m,
        )
        .await
        .map_err(internal)?;
    Ok(Json(stats))
}

async fn poi_pick_country_stats_handler(
    State(state): State<AppState>,
) -> Result<Json<PoiPickCountryStats>, ApiError> {
    let stats = state
        .store
        .aggregate_poi_pick_country_stats()
        .await
        .map_err(internal)?;
    Ok(Json(stats))
}

async fn poi_focus_measurement_destination_warnings_handler(
    State(state): State<AppState>,
) -> Result<Json<PoiFocusMeasurementDestinationWarningsResponse>, ApiError> {
    let body = state
        .store
        .poi_focus_measurement_destination_warnings(
            state.config.measurement_destination_match_radius_m,
        )
        .await
        .map_err(internal)?;
    Ok(Json(body))
}

#[derive(Debug, Serialize)]
pub struct PoiFocusMeasurementsResponse {
    pub measurements: Vec<PoiFocusMeasurement>,
}

fn measurement_validation_error(msg: &'static str) -> ApiError {
    (StatusCode::BAD_REQUEST, msg.to_string())
}

async fn poi_focus_measurements_list_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
) -> Result<Json<PoiFocusMeasurementsResponse>, ApiError> {
    let _kept = state
        .store
        .get_kept(bbox_id)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("kept bbox {bbox_id} not found"),
        ))?;
    let measurements = state
        .store
        .list_poi_focus_measurements(bbox_id)
        .await
        .map_err(internal)?;
    Ok(Json(PoiFocusMeasurementsResponse { measurements }))
}

async fn poi_focus_measurements_create_handler(
    State(state): State<AppState>,
    Path(bbox_id): Path<Uuid>,
    Json(body): Json<PoiFocusMeasurementUpsertBody>,
) -> Result<Json<PoiFocusMeasurement>, ApiError> {
    let _kept = state
        .store
        .get_kept(bbox_id)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("kept bbox {bbox_id} not found"),
        ))?;
    validate_coordinates(&body.coordinates).map_err(measurement_validation_error)?;
    validate_walking_speed_kmh(body.walking_speed_kmh).map_err(measurement_validation_error)?;
    validate_measurement_start_for_write(body.start_origin, body.start_osm_node_id)
        .map_err(measurement_validation_error)?;
    let length_m = path_length_m_haversine(&body.coordinates).expect("validated >= 2 points");
    let row = state
        .store
        .insert_poi_focus_measurement(
            bbox_id,
            body.coordinates.as_slice(),
            body.walking_speed_kmh,
            length_m,
            body.measurement_type,
            body.entrance_type,
            body.start_origin.into(),
            body.start_osm_node_id,
        )
        .await
        .map_err(internal)?;
    Ok(Json(row))
}

async fn poi_focus_measurements_update_handler(
    State(state): State<AppState>,
    Path((bbox_id, measure_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PoiFocusMeasurementUpsertBody>,
) -> Result<Json<PoiFocusMeasurement>, ApiError> {
    let _kept = state
        .store
        .get_kept(bbox_id)
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("kept bbox {bbox_id} not found"),
        ))?;
    validate_coordinates(&body.coordinates).map_err(measurement_validation_error)?;
    validate_walking_speed_kmh(body.walking_speed_kmh).map_err(measurement_validation_error)?;
    validate_measurement_start_for_write(body.start_origin, body.start_osm_node_id)
        .map_err(measurement_validation_error)?;
    let length_m = path_length_m_haversine(&body.coordinates).expect("validated >= 2 points");
    let row = state
        .store
        .update_poi_focus_measurement(
            bbox_id,
            measure_id,
            body.coordinates.as_slice(),
            body.walking_speed_kmh,
            length_m,
            body.measurement_type,
            body.entrance_type,
            body.start_origin.into(),
            body.start_osm_node_id,
        )
        .await
        .map_err(internal)?
        .ok_or((
            StatusCode::NOT_FOUND,
            format!("measurement {measure_id} not found for bbox {bbox_id}"),
        ))?;
    Ok(Json(row))
}

async fn poi_focus_measurements_delete_handler(
    State(state): State<AppState>,
    Path((bbox_id, measure_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let deleted = state
        .store
        .delete_poi_focus_measurement(bbox_id, measure_id)
        .await
        .map_err(internal)?;
    if !deleted {
        return Err((
            StatusCode::NOT_FOUND,
            format!("measurement {measure_id} not found for bbox {bbox_id}"),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Map any Overpass-side failure to HTTP 502. We deliberately do not
/// forward the upstream status code — a 401/403/429 from Overpass is
/// not a 401/403/429 from *us* and propagating it would mislead the
/// caller about which service is unhealthy.
fn overpass_error(err: OverpassError) -> ApiError {
    match &err {
        OverpassError::NoOsmElement => (StatusCode::NOT_FOUND, err.to_string()),
        OverpassError::InvalidOsmGeometry => (StatusCode::UNPROCESSABLE_ENTITY, err.to_string()),
        _ => (StatusCode::BAD_GATEWAY, format!("overpass: {err}")),
    }
}

/// Deterministic “picked POI” for custom lat/lon cells (`osm_id` 0 — not an OSM object).
fn synthetic_centroid_poi(bbox: &Bbox) -> Poi {
    let mut tags = BTreeMap::new();
    tags.insert(
        "note".to_string(),
        "Focus at the coordinates you entered (custom centroid).".to_string(),
    );
    Poi {
        osm_type: OsmType::Node,
        osm_id: 0,
        center: bbox.center,
        tags,
        group: "custom_centroid".to_string(),
    }
}

/// Picked POI for a cell centred on an explicit OSM anchor (same id as the user chose).
fn custom_osm_anchor_poi(bbox: &Bbox) -> Result<Poi, String> {
    let ty = bbox
        .custom_osm_type
        .as_deref()
        .ok_or_else(|| "missing custom_osm_type".to_string())?;
    let id = bbox
        .custom_osm_id
        .ok_or_else(|| "missing custom_osm_id".to_string())?;
    let osm_type = OsmType::from_overpass(ty)
        .ok_or_else(|| format!("invalid custom_osm_type {ty:?}"))?;
    Ok(Poi {
        osm_type,
        osm_id: id,
        center: bbox.center,
        tags: BTreeMap::new(),
        group: "custom_osm".to_string(),
    })
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
}

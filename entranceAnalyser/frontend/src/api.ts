/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Typed client for the `entrance-analyser-backend` HTTP API.
//!
//! In development, `/api/...` is proxied to `http://127.0.0.1:3000/api/...`
//! by `vite.config.ts`, so no absolute URL is needed here. The caller
//! decides how to surface errors; every helper throws on non-OK responses.

import type { EntranceType, MeasurementPurpose } from './keptBboxes/measurementCatalog';

/** How a candidate bbox was produced; stored on keep (`kept_bboxes.candidate_source`). */
export type CandidateSource = 'random' | 'custom_centroid' | 'custom_osm';

/** Matches `Bbox` in `backend/src/bbox.rs`. */
export interface Bbox {
    id: string;
    west: number;
    south: number;
    east: number;
    north: number;
    center: [number, number];
    /** Side length of the bbox in kilometres. */
    cell_size_km: number;
    /** Total population inside the bbox (from GHS-POP). */
    population: number;
    /** `population / cell_size_km²`. */
    density_per_km2: number;
    /** `density_per_km2 / max_density_per_km2_in_grid`, in `[0, 1]`. */
    max_density_ratio: number;
    /** Total built volume (m³) inside the bbox, from GHS-BUILT-V. */
    built_volume: number;
    /** `built_volume / max_built_volume_in_grid`, in `[0, 1]`. */
    max_built_volume_ratio: number;
    /** Random grid draw vs custom centroid vs OSM anchor; omitted in older API payloads → treat as `random`. */
    candidate_source?: CandidateSource;
    /** Set when `candidate_source === 'custom_osm'` (node/way/relation used for the centre). */
    custom_osm_type?: string;
    custom_osm_id?: number;
}

/** Sampling strategies exposed by the backend. Matches the `StrategyName`
 *  enum in `backend/src/api.rs`. */
export type StrategyName = 'uniform' | 'population' | 'built' | 'blended';

/** Client-side representation of a `/random?strategy=...&alpha=...` query. */
export interface Strategy {
    name: StrategyName;
    /** Only consulted when `name === 'blended'`. Must be in [0, 1]. */
    alpha: number;
}

/** Default strategy the UI opens with — mirrors the backend default. */
export const DEFAULT_STRATEGY: Strategy = { name: 'blended', alpha: 0.5 };

/** Matches `KeptBbox` (Bbox flattened with a `kept_at` timestamp). */
export interface KeptBbox extends Bbox {
    kept_at: string;
}

export type Decision = 'keep' | 'reject';

export interface DecisionResponse {
    ok: boolean;
    /** Total number of kept bboxes after this decision, from `SELECT COUNT(*)`. */
    total_kept: number;
}

const BASE = '/api/bbox';

async function jsonOrThrow<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${response.status} ${response.statusText}: ${body}`.trim());
    }
    return response.json() as Promise<T>;
}

/**
 * `GET /api/bbox/random?strategy=...&alpha=...` — fetch a fresh candidate
 * bbox under the given sampling strategy. The `alpha` parameter is only
 * emitted for `blended`; the backend rejects out-of-range alphas with
 * 400, and built/blended surface 503 when the grid was built without
 * GHS-BUILT-V.
 */
export async function fetchRandomBbox(
    strategy: Strategy = DEFAULT_STRATEGY,
    fetchFn: typeof fetch = fetch,
): Promise<Bbox> {
    const params = new URLSearchParams({ strategy: strategy.name });
    if (strategy.name === 'blended') {
        params.set('alpha', String(strategy.alpha));
    }
    return jsonOrThrow<Bbox>(await fetchFn(`${BASE}/random?${params}`));
}

/**
 * `POST /api/bbox/custom_centroid` — candidate bbox centred on the given
 * WGS84 point. Population and built-volume figures come from the nearest
 * grid cell so the panel stays consistent with `/random`.
 *
 * @param lat - Degrees north (EPSG:4326 `y`)
 * @param lon - Degrees east (EPSG:4326 `x`)
 */
export async function fetchBboxAtCustomCentroid(
    lat: number,
    lon: number,
    fetchFn: typeof fetch = fetch,
): Promise<Bbox> {
    return jsonOrThrow<Bbox>(
        await fetchFn(`${BASE}/custom_centroid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lon }),
        }),
    );
}

/**
 * `POST /api/bbox/custom_osm` — candidate bbox centred on Overpass `out center`
 * for the given `node/…`, `way/…`, or `relation/…`. Grid stats from nearest cell.
 *
 * @param osm_ref - e.g. `way/123456789`
 */
export async function fetchBboxAtCustomOsm(osm_ref: string, fetchFn: typeof fetch = fetch): Promise<Bbox> {
    return jsonOrThrow<Bbox>(
        await fetchFn(`${BASE}/custom_osm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ osm_ref }),
        }),
    );
}

/**
 * `POST /api/bbox/decision` — keep or reject an emitted bbox.
 *
 * The full bbox is echoed back to the backend (instead of just the id)
 * so the server can persist it in a single round-trip without holding
 * any per-session state.
 */
export async function submitDecision(
    bbox: Bbox,
    decision: Decision,
    fetchFn: typeof fetch = fetch,
): Promise<DecisionResponse> {
    const response = await fetchFn(`${BASE}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox, decision }),
    });
    return jsonOrThrow<DecisionResponse>(response);
}

/** `GET /api/bbox/kept` — list every kept bbox currently on disk. */
export async function fetchKept(fetchFn: typeof fetch = fetch): Promise<KeptBbox[]> {
    const { kept } = await jsonOrThrow<{ kept: KeptBbox[] }>(await fetchFn(`${BASE}/kept`));
    return kept;
}

/**
 * `DELETE /api/bbox/kept/:id` — remove one kept bbox. Cascades to
 * `analyses` (poi_pick, poi_focus, …) and `poi_focus_measurements`.
 */
export async function deleteKept(bboxId: string, fetchFn: typeof fetch = fetch): Promise<void> {
    const response = await fetchFn(`${BASE}/kept/${bboxId}`, { method: 'DELETE' });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${response.status} ${response.statusText}: ${body}`.trim());
    }
}

/** Matches `OsmType` in `backend/src/overpass.rs`. */
export type OsmType = 'node' | 'way' | 'relation';

/** One picked POI — mirrors `Poi` in `backend/src/overpass.rs`. */
export interface Poi {
    osm_type: OsmType;
    osm_id: number;
    /** `[lon, lat]`, GeoJSON order — matches `Bbox.center`. */
    center: [number, number];
    /** Raw OSM tags as returned by Overpass. */
    tags: Record<string, string>;
    /** Group label resolved against `config/poi_tags.yml`. */
    group: string;
}

/** Why the reviewer flagged this POI as unusable for analysis.
 *  Mirrors `PoiRejectionReason` in `backend/src/storage.rs`. */
export type PoiRejectionReason = 'no_imagery' | 'obsolete' | 'other';

/** Matches `PoiPickResponse` in `backend/src/api.rs`. `poi` is `null`
 *  when Overpass ran but matched no feature inside the bbox; absence
 *  of an entry means the pick has not been requested yet.
 *
 *  `completed` and `rejected` are the two terminal reviewer states and
 *  are mutually exclusive. When both are `false` the pick is "pending".
 *  `rejected_reason` is non-null iff `rejected` is `true`. */
export interface PoiPickRecord {
    bbox_id: string;
    poi: Poi | null;
    /** Reviewer flag: show this POI as completed (green) on the overview map. */
    completed: boolean;
    /** Reviewer flag: POI dropped from the analysis (red/grey marker on the focus map). */
    rejected: boolean;
    rejected_reason: PoiRejectionReason | null;
}

/** Cached pick row merged into `usePoiPicks` state (no `bbox_id` in value). */
export interface PoiPickEntry {
    poi: Poi | null;
    completed: boolean;
    rejected: boolean;
    rejected_reason: PoiRejectionReason | null;
}

/** Discriminated union of the three reviewer transitions accepted by
 *  `PATCH /api/bbox/kept/:id/poi_pick`. The wire shape is built by
 *  [`patchPoiPickDecision`] so callers never craft the JSON body
 *  manually. Mirrors the backend `PoiPickDecision` enum. */
export type PoiPickDecision =
    | { kind: 'completed'; value: boolean }
    | { kind: 'rejected'; reason: PoiRejectionReason }
    | { kind: 'unreject' };

const ANALYSES_BASE = '/api/analyses';

/**
 * `POST /api/bbox/kept/:id/poi_pick` — pick (and cache) one POI in a
 * kept bbox. Idempotent: subsequent calls return the cached pick
 * without re-rolling the random choice.
 */
export async function pickPoi(
    bboxId: string,
    fetchFn: typeof fetch = fetch,
): Promise<PoiPickRecord> {
    return jsonOrThrow<PoiPickRecord>(
        await fetchFn(`${BASE}/kept/${bboxId}/poi_pick`, { method: 'POST' }),
    );
}

/**
 * `PATCH /api/bbox/kept/:id/poi_pick` — apply one reviewer transition
 * to an existing pick. Each `PoiPickDecision` variant projects to the
 * minimum body the backend validator accepts, which keeps the wire
 * surface small and the 422 cases trivially exclusive.
 *
 * @param bboxId   Kept-bbox id whose pick row is being mutated.
 * @param decision One of the three accepted transitions.
 * @param fetchFn  Test seam for injecting a stub fetch.
 */
export async function patchPoiPickDecision(
    bboxId: string,
    decision: PoiPickDecision,
    fetchFn: typeof fetch = fetch,
): Promise<PoiPickRecord> {
    const body = decisionToBody(decision);
    return jsonOrThrow<PoiPickRecord>(
        await fetchFn(`${BASE}/kept/${bboxId}/poi_pick`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

/** Project a [`PoiPickDecision`] onto the wire body the backend
 *  expects. Exported so unit tests can assert the projection without
 *  re-running the fetch. */
export function decisionToBody(
    decision: PoiPickDecision,
): { completed?: boolean; rejected?: boolean; rejected_reason?: PoiRejectionReason } {
    switch (decision.kind) {
        case 'completed':
            return { completed: decision.value };
        case 'rejected':
            return { rejected: true, rejected_reason: decision.reason };
        case 'unreject':
            return { rejected: false };
    }
}

/** `GET /api/analyses/poi_picks` — every cached POI pick on disk, in
 *  insertion order, so the map can paint markers on load. */
export async function fetchPoiPicks(
    fetchFn: typeof fetch = fetch,
): Promise<PoiPickRecord[]> {
    const { picks } = await jsonOrThrow<{ picks: PoiPickRecord[] }>(
        await fetchFn(`${ANALYSES_BASE}/poi_picks`),
    );
    return picks;
}

// -------- POI focus map (PR9) ------------------------------------------------

/** Minimal GeoJSON geometry, mirroring `Geometry` in
 *  `backend/src/poi_focus.rs`. The backend emits Point features for
 *  `entrance=*` (including `entrance=yes`) and `routing:entrance=*`
 *  nodes, plus Polygons with a single outer ring (buildings); both
 *  shapes are valid drop-ins for a MapLibre `geojson` source. */
export type FocusGeometry =
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'Polygon'; coordinates: [number, number][][] };

/** Mirrors `Feature` in `backend/src/poi_focus.rs`. `id` is stable
 *  (`"node/123"`, `"way/456"`) so MapLibre can dedupe on it. */
export interface FocusFeature {
    type: 'Feature';
    id: string;
    geometry: FocusGeometry;
    properties: Record<string, string>;
}

export interface FocusFeatureCollection {
    type: 'FeatureCollection';
    features: FocusFeature[];
}

/** Mirrors `PoiFocusResult` in `backend/src/poi_focus.rs`. `radius_m`
 *  is echoed by the server so the frontend can draw the buffer ring
 *  without needing to know the active server config. */
export interface PoiFocusResult {
    /** `[lon, lat]`, GeoJSON order — anchor of the `around:` query. */
    center: [number, number];
    radius_m: number;
    buildings: FocusFeatureCollection;
    entrances: FocusFeatureCollection;
}

/** Mirrors `PoiFocusResponse` in `backend/src/api.rs`. */
export interface PoiFocusRecord {
    bbox_id: string;
    result: PoiFocusResult;
}

/**
 * `POST /api/bbox/kept/:id/poi_focus` — fetch (and cache) the
 * buildings + entrances around the previously-picked POI.
 *
 * The server caches one focus result per bbox keyed on the radius
 * it was computed at. Calling with the same radius is idempotent
 * (cache hit, no Overpass call); calling with a *different*
 * `radiusM` re-issues the Overpass query and overwrites the cached
 * row. Pass `{ refresh: true }` to force a new Overpass fetch at the
 * same radius (for example after OSM edits). When `radiusM` is
 * omitted, the backend falls back to its `POI_FOCUS_RADIUS_M`
 * default (currently 150 m).
 *
 * Backend returns 400 when `radiusM` is outside the documented
 * range (`[10, 2000]`), 409 when no pick has run yet, and 422 when
 * the pick was empty. All three surface as a thrown `Error` whose
 * message starts with the status code, so the caller can branch
 * on it.
 *
 * @param bboxId  - UUID of the kept bbox.
 * @param radiusM - Per-request override for the `around:` buffer
 *                  (metres). Falls back to the server default when
 *                  omitted.
 * @param third - Options (`refresh`, `fetchFn`) or a bare `fetch`
 *                implementation for backward-compatible tests.
 */
export interface PickPoiFocusOptions {
    refresh?: boolean;
    fetchFn?: typeof fetch;
}

function resolvePickPoiFocusOptions(third?: PickPoiFocusOptions | typeof fetch): {
    refresh: boolean;
    fetchFn: typeof fetch;
} {
    if (third === undefined) {
        return { refresh: false, fetchFn: fetch };
    }
    if (typeof third === 'function') {
        return { refresh: false, fetchFn: third };
    }
    return {
        refresh: third.refresh ?? false,
        fetchFn: third.fetchFn ?? fetch,
    };
}

export async function pickPoiFocus(
    bboxId: string,
    radiusM?: number,
    third?: PickPoiFocusOptions | typeof fetch,
): Promise<PoiFocusRecord> {
    const { refresh, fetchFn } = resolvePickPoiFocusOptions(third);
    const params = new URLSearchParams();
    if (radiusM !== undefined) {
        params.set('radius_m', String(radiusM));
    }
    if (refresh) {
        params.set('refresh', 'true');
    }
    const qs = params.toString();
    const url =
        qs === ''
            ? `${BASE}/kept/${bboxId}/poi_focus`
            : `${BASE}/kept/${bboxId}/poi_focus?${qs}`;
    return jsonOrThrow<PoiFocusRecord>(await fetchFn(url, { method: 'POST' }));
}

/** `GET /api/analyses/poi_focuses` — every cached focus result on
 *  disk, in insertion order, for hydrating the map on load. */
export async function fetchPoiFocuses(
    fetchFn: typeof fetch = fetch,
): Promise<PoiFocusRecord[]> {
    const { focuses } = await jsonOrThrow<{ focuses: PoiFocusRecord[] }>(
        await fetchFn(`${ANALYSES_BASE}/poi_focuses`),
    );
    return focuses;
}

// -------- POI focus measurements (persisted polylines) -------------------------

/** Where the first vertex is anchored (`legacy_unknown` = rows before migration 0008). */
export type MeasurementStartOrigin =
    | 'poi_focus_centroid'
    | 'osm_entrance'
    | 'legacy_unknown'
    | 'building_centroid'
    | 'unsnapped_start';

/** Mirrors `PoiFocusMeasurement` in `backend/src/focus_measurements.rs`. */
export interface PoiFocusMeasurement {
    id: string;
    bbox_id: string;
    coordinates: [number, number][];
    walking_speed_kmh: number;
    length_m: number;
    measurement_type: MeasurementPurpose;
    entrance_type: EntranceType;
    start_origin: MeasurementStartOrigin;
    /** OSM node id (`osm_entrance`), OSM way id (`building_centroid`); otherwise `null`. */
    start_osm_node_id: number | null;
    created_at: string;
}

/** Request body for POST/PATCH measurement endpoints. */
export interface PoiFocusMeasurementWriteBody {
    coordinates: [number, number][];
    walking_speed_kmh: number;
    measurement_type: MeasurementPurpose;
    entrance_type: EntranceType;
    start_origin: Exclude<MeasurementStartOrigin, 'legacy_unknown'>;
    start_osm_node_id: number | null;
}

/** `GET /api/bbox/kept/:id/poi_focus_measurements` */
export async function fetchPoiFocusMeasurements(
    bboxId: string,
    fetchFn: typeof fetch = fetch,
): Promise<PoiFocusMeasurement[]> {
    const { measurements } = await jsonOrThrow<{ measurements: PoiFocusMeasurement[] }>(
        await fetchFn(`${BASE}/kept/${bboxId}/poi_focus_measurements`),
    );
    return measurements;
}

/** `POST /api/bbox/kept/:id/poi_focus_measurements` */
export async function createPoiFocusMeasurement(
    bboxId: string,
    body: PoiFocusMeasurementWriteBody,
    fetchFn: typeof fetch = fetch,
): Promise<PoiFocusMeasurement> {
    return jsonOrThrow<PoiFocusMeasurement>(
        await fetchFn(`${BASE}/kept/${bboxId}/poi_focus_measurements`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

/** `PATCH /api/bbox/kept/:id/poi_focus_measurements/:measureId` */
export async function updatePoiFocusMeasurement(
    bboxId: string,
    measureId: string,
    body: PoiFocusMeasurementWriteBody,
    fetchFn: typeof fetch = fetch,
): Promise<PoiFocusMeasurement> {
    return jsonOrThrow<PoiFocusMeasurement>(
        await fetchFn(`${BASE}/kept/${bboxId}/poi_focus_measurements/${measureId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    );
}

/** `DELETE /api/bbox/kept/:id/poi_focus_measurements/:measureId` */
export async function deletePoiFocusMeasurement(
    bboxId: string,
    measureId: string,
    fetchFn: typeof fetch = fetch,
): Promise<void> {
    const response = await fetchFn(
        `${BASE}/kept/${bboxId}/poi_focus_measurements/${measureId}`,
        { method: 'DELETE' },
    );
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${response.status} ${response.statusText}: ${body}`.trim());
    }
}

/** Min / max / mean / median for length (m) or duration (s). Mirrors `MeasurementFourNumberStats`. */
export interface MeasurementFourNumberStats {
    min: number;
    max: number;
    avg: number;
    median: number;
}

/** One grouped row from `GET /api/analyses/poi_focus_measurement_stats`. */
export interface MeasurementPairAggregate {
    attr_a: string;
    attr_b: string;
    n: number;
    length_m: MeasurementFourNumberStats;
    duration_s: MeasurementFourNumberStats;
}

/** Signed (centroid − main entrance) delta stats for one measurement type.
 *  `n` counts (main, centroid_*) measurement pairs of the same POI.
 *  Mirrors `MeasurementDeltaAggregate`. */
export interface MeasurementDeltaAggregate {
    measurement_type: string;
    n: number;
    delta_length_m: MeasurementFourNumberStats;
    delta_duration_s: MeasurementFourNumberStats;
}

/** Endpoint agreement between centroid- and main-entrance-anchored walks
 *  for one destination type. Mirrors `EndpointAgreementStat`. */
export interface EndpointAgreementStat {
    measurement_type: string;
    n_pairs: number;
    n_mismatch: number;
}

/** Wire shape for `GET /api/analyses/poi_focus_measurement_stats`. */
export interface PoiFocusMeasurementStats {
    by_measurement_type_and_entrance_type: MeasurementPairAggregate[];
    by_measurement_type_and_start_origin: MeasurementPairAggregate[];
    by_entrance_type_and_start_origin: MeasurementPairAggregate[];
    main_entrance_vs_centroid: MeasurementDeltaAggregate[];
    main_entrance_vs_centroid_endpoints: EndpointAgreementStat[];
}

/** `GET /api/analyses/poi_focus_measurement_stats` — global aggregates by attribute pairs. */
export async function fetchPoiFocusMeasurementStats(
    fetchFn: typeof fetch = fetch,
): Promise<PoiFocusMeasurementStats> {
    return jsonOrThrow<PoiFocusMeasurementStats>(
        await fetchFn(`${ANALYSES_BASE}/poi_focus_measurement_stats`),
    );
}

/** POI counts for one country. `n_in_quebec` is the subset of `n` inside
 *  Quebec (relevant for `iso_code === 'CA'`); Quebec POIs will be treated
 *  separately in future statistics. Mirrors `PoiPickCountryCount`. */
export interface PoiPickCountryCount {
    iso_code: string;
    name: string;
    n: number;
    n_in_quebec: number;
}

/** Wire shape for `GET /api/analyses/poi_pick_country_stats`. */
export interface PoiPickCountryStats {
    /** Sorted by `n` descending, then country name. */
    by_country: PoiPickCountryCount[];
    /** Every picked POI, including unresolved ones. */
    total: number;
    /** POIs matching no loaded country polygon. */
    unresolved: number;
}

/** `GET /api/analyses/poi_pick_country_stats` — POI counts per country (+ Quebec subset). */
export async function fetchPoiPickCountryStats(
    fetchFn: typeof fetch = fetch,
): Promise<PoiPickCountryStats> {
    return jsonOrThrow<PoiPickCountryStats>(
        await fetchFn(`${ANALYSES_BASE}/poi_pick_country_stats`),
    );
}

/** One POI (`bbox_id`) with destination mismatch warnings from the focus map. */
export interface PoiMeasurementDestinationWarnings {
    bbox_id: string;
    warnings: string[];
}

/** `GET /api/analyses/poi_focus_measurement_destination_warnings` */
export interface PoiFocusMeasurementDestinationWarningsResponse {
    warnings: PoiMeasurementDestinationWarnings[];
}

/**
 * Destination mismatch warnings for every kept POI that has at least one
 * warning (same 5 m endpoint rule as the focus-map UI).
 */
export async function fetchPoiFocusMeasurementDestinationWarnings(
    fetchFn: typeof fetch = fetch,
): Promise<PoiFocusMeasurementDestinationWarningsResponse> {
    return jsonOrThrow<PoiFocusMeasurementDestinationWarningsResponse>(
        await fetchFn(`${ANALYSES_BASE}/poi_focus_measurement_destination_warnings`),
    );
}

// -------- Public runtime config (PR10) ---------------------------------------

/** Mirrors `AppConfig` in `backend/src/api.rs`. Read once on app
 *  mount; the backend re-reads its env at startup, so values change
 *  by restarting the backend rather than rebuilding the frontend.
 *  The `osm_editor_url` template supports `{lat}` / `{lon}` /
 *  `{zoom}` placeholders, which the frontend substitutes at click
 *  time when opening the OSM editor. */
export interface AppConfig {
    osm_editor_url: string;
    poi_focus_radius_m: number;
    measurement_destination_match_radius_m: number;
}

/** `GET /api/config` — fetch the public-facing runtime config. */
export async function fetchAppConfig(fetchFn: typeof fetch = fetch): Promise<AppConfig> {
    return jsonOrThrow<AppConfig>(await fetchFn('/api/config'));
}

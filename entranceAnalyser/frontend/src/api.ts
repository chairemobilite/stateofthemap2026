//! Typed client for the `entrance-analyser-backend` HTTP API.
//!
//! In development, `/api/...` is proxied to `http://127.0.0.1:3000/api/...`
//! by `vite.config.ts`, so no absolute URL is needed here. The caller
//! decides how to surface errors; every helper throws on non-OK responses.

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

/** Matches `PoiPickResponse` in `backend/src/api.rs`. `poi` is `null`
 *  when Overpass ran but matched no feature inside the bbox; absence
 *  of an entry means the pick has not been requested yet. */
export interface PoiPickRecord {
    bbox_id: string;
    poi: Poi | null;
}

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

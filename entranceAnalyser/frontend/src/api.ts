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
    population: number | null;
    filtered: boolean;
}

/** Matches `KeptBbox` (Bbox flattened with a `kept_at` timestamp). */
export interface KeptBbox extends Bbox {
    kept_at: string;
}

export type Decision = 'keep' | 'reject';

export interface DecisionResponse {
    ok: boolean;
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

/** `GET /api/bbox/random` — fetch a fresh candidate bbox. */
export async function fetchRandomBbox(fetchFn: typeof fetch = fetch): Promise<Bbox> {
    return jsonOrThrow<Bbox>(await fetchFn(`${BASE}/random`));
}

/** `POST /api/bbox/decision` — keep or reject an emitted bbox by id. */
export async function submitDecision(
    id: string,
    decision: Decision,
    fetchFn: typeof fetch = fetch,
): Promise<DecisionResponse> {
    const response = await fetchFn(`${BASE}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
    });
    return jsonOrThrow<DecisionResponse>(response);
}

/** `GET /api/bbox/kept` — list every kept bbox currently on disk. */
export async function fetchKept(fetchFn: typeof fetch = fetch): Promise<KeptBbox[]> {
    const { kept } = await jsonOrThrow<{ kept: KeptBbox[] }>(await fetchFn(`${BASE}/kept`));
    return kept;
}

/**
 * Pure helpers for the POI focus map measurement tool (path length,
 * walking-time estimate, speed parsing).
 *
 * Extracted so the math is unit-testable without MapLibre/DOM and
 * so PoiFocusMap.tsx stays as small as possible (react-refresh rule).
 * Matches the split used by focusRadius.ts and poiFocusGeoJson.ts.
 */

import type { LngLatLike } from 'maplibre-gl';
import maplibregl from 'maplibre-gl';

/** Default walking speed in km/h. Typical brisk pedestrian pace. */
export const DEFAULT_WALKING_SPEED_KMH = 5.0;

/** Minimum practical speed (crawl). */
export const MIN_WALKING_SPEED_KMH = 0.5;

/** Maximum practical speed (fast walk/jog). */
export const MAX_WALKING_SPEED_KMH = 10.0;

/**
 * Max screen distance (px) from the projected POI focus centre, entrance
 * node, or building-centroid dot for: (1) UI dead zone — do not select saved
 * lines or edit a draft when the click lands here (except the first vertex of
 * a brand-new measurement); (2) snapping the first vertex / insert-on-line to
 * those anchors (`PoiFocusMap`, `inferMeasurementStart`). Kept tight (≤10px)
 * so large sites stay usable.
 */
export const ANCHOR_UI_GUARD_PX = 8;

/** @deprecated Use [`ANCHOR_UI_GUARD_PX`] (same value). */
export const POI_FOCUS_CENTER_UI_GUARD_PX = ANCHOR_UI_GUARD_PX;

/** @deprecated Use [`ANCHOR_UI_GUARD_PX`] (same value). */
export const ENTRANCE_UI_GUARD_PX = ANCHOR_UI_GUARD_PX;

/** Euclidean distance between two map container pixel points. */
export function pixelDistance(
    a: { x: number; y: number },
    b: { x: number; y: number },
): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** MapLibre-style `map.project` signature for tests and snap helpers. */
export type AnchorScreenProjectFn = (lon: number, lat: number) => { x: number; y: number };

/**
 * Snap a map-container click (`MapMouseEvent.point`) to the nearest
 * `[lon, lat]` among `targets` when screen distance ≤ `maxPx`. Ties favour
 * the earlier target in the list.
 *
 * @param clickScreen - Container pixel coordinates of the click
 * @param targets - Candidate anchor positions
 * @param project - Same projection as the map (e.g. `(lon, lat) => map.project({ lng: lon, lat })`)
 * @param maxPx - Radius in pixels (typically [`ANCHOR_UI_GUARD_PX`])
 */
export function snapClickToNearestAnchorPx(
    clickScreen: { x: number; y: number },
    targets: ReadonlyArray<readonly [number, number]>,
    project: AnchorScreenProjectFn,
    maxPx: number,
): [number, number] | null {
    if (targets.length === 0 || !Number.isFinite(maxPx) || maxPx <= 0) {
        return null;
    }
    let best: [number, number] | null = null;
    let bestPx = maxPx + 1;
    for (const t of targets) {
        const d = pixelDistance(clickScreen, project(t[0], t[1]));
        if (d <= maxPx && d < bestPx) {
            bestPx = d;
            best = [t[0], t[1]];
        }
    }
    return best;
}

/**
 * Calculate geodesic path length of a polyline in metres using
 * successive `LngLat.distanceTo()` calls. Returns 0 for < 2 points.
 *
 * Uses MapLibre's built-in Haversine implementation — no extra
 * dependency required and matches the buffer ring approximation style
 * in poiFocusGeoJson.ts.
 */
export function calculatePathLength(points: LngLatLike[]): number {
    if (points.length < 2) return 0;

    let total = 0;

    for (let i = 1; i < points.length; i++) {
        // LngLat.convert is the canonical narrowing for LngLatLike — accepts
        // tuple, object, or LngLat instance — instead of numeric indexing,
        // which broke when LngLatLike was widened to a union of shapes.
        const prev = maplibregl.LngLat.convert(points[i - 1]);
        const curr = maplibregl.LngLat.convert(points[i]);
        total += prev.distanceTo(curr);
    }

    return Math.round(total);
}

/**
 * Estimate walking time in minutes for a given distance at the
 * specified speed. Rounds to nearest minute. Returns 0 if speed <= 0.
 *
 * Formula: minutes = (distanceM / 1000) / (speedKmh / 60)
 */
export function estimateWalkingTimeMinutes(
    distanceM: number,
    speedKmh: number = DEFAULT_WALKING_SPEED_KMH,
): number {
    if (distanceM <= 0 || speedKmh <= 0) return 0;
    const hours = distanceM / 1000 / speedKmh;
    return Math.round(hours * 60);
}

/**
 * Parse a walking speed input string. Mirrors parseFocusRadiusInput
 * pattern. Returns null for invalid/empty/out-of-range values.
 */
export function parseWalkingSpeedInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < MIN_WALKING_SPEED_KMH || n > MAX_WALKING_SPEED_KMH) {
        return null;
    }
    return n;
}

/** Local equirectangular metres relative to `refLng` / `refLat` (short segments). */
function lngLatToLocalM(lng: number, lat: number, refLng: number, refLat: number): { x: number; y: number } {
    const cos = Math.cos((refLat * Math.PI) / 180);
    const x = (lng - refLng) * 111320 * cos;
    const y = (lat - refLat) * 110540;
    return { x, y };
}

function localMToLngLat(x: number, y: number, refLng: number, refLat: number): [number, number] {
    const cos = Math.cos((refLat * Math.PI) / 180);
    const lng = refLng + x / (111320 * cos);
    const lat = refLat + y / 110540;
    return [lng, lat];
}

/**
 * Finds the segment closest to `click` and returns the splice index and
 * snapped `[lng, lat]` on that segment. Planar approximation in local
 * metres (fine for building-scale polylines). Returns `null` if there are
 * fewer than two vertices.
 *
 * @param points Polyline vertices in order
 * @param click Map click position
 * @returns `{ insertIndex, position }` with `position` snapped on the chosen segment (`insertIndex` is the `splice` index), or `null` if `points.length < 2`
 */
export function insertVertexAlongPolyline(
    points: LngLatLike[],
    click: { lng: number; lat: number },
): { insertIndex: number; position: [number, number] } | null {
    if (points.length < 2) return null;

    let refLng = 0;
    let refLat = 0;
    for (const p of points) {
        const q = p as [number, number];
        refLng += q[0];
        refLat += q[1];
    }
    refLng /= points.length;
    refLat /= points.length;

    const c = lngLatToLocalM(click.lng, click.lat, refLng, refLat);

    let bestInsert = 1;
    let bestDistSq = Infinity;
    let bestPos: [number, number] = [click.lng, click.lat];

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i] as [number, number];
        const p1 = points[i + 1] as [number, number];
        const a = lngLatToLocalM(p0[0], p0[1], refLng, refLat);
        const b = lngLatToLocalM(p1[0], p1[1], refLng, refLat);
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const den = abx * abx + aby * aby;
        const t = den === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * abx + (c.y - a.y) * aby) / den));
        const sx = a.x + t * abx;
        const sy = a.y + t * aby;
        const dSq = (c.x - sx) ** 2 + (c.y - sy) ** 2;
        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestInsert = i + 1;
            bestPos = localMToLngLat(sx, sy, refLng, refLat);
        }
    }

    return { insertIndex: bestInsert, position: bestPos };
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Point-in-polygon test for Quebec using the same hand-corrected
//! boundary the backend loads from `config/quebec_boundary.geojson`.

import { QUEBEC_BOUNDARY_RING } from '../data/quebecBoundaryRing';

type LonLat = [number, number];

const QUEBEC_RING: LonLat[] = QUEBEC_BOUNDARY_RING;

/** Ray-casting test for one closed ring (`[lon, lat]` vertices). */
function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        const intersects =
            yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

/**
 * True when `lon`/`lat` falls inside the bundled Quebec boundary polygon.
 * Matches the backend's `bbox_in_quebec` rule when the bbox centre is used.
 *
 * @param lon - East longitude (WGS84).
 * @param lat - North latitude (WGS84).
 */
export function isPointInQuebec(lon: number, lat: number): boolean {
    if (QUEBEC_RING.length === 0) return false;
    return pointInRing(lon, lat, QUEBEC_RING);
}

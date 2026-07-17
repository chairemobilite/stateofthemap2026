/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Reviewer-facing POI labels — mirrors `backend/src/poi_display_name.rs`.

import type { Poi } from '../api';

const NAME_KEYS = ['name', 'name:fr', 'name:en'] as const;

/** Prefer `name`, then `name:fr`, then `name:en`. */
export function baseNameFromTags(tags: Record<string, string>): string | null {
    for (const key of NAME_KEYS) {
        const value = tags[key]?.trim();
        if (value) return value;
    }
    return null;
}

/** Trimmed `branch` tag when present. */
export function branchFromTags(tags: Record<string, string>): string | null {
    const value = tags['branch']?.trim();
    return value || null;
}

/** Build `name | branch` when both exist. */
export function formatPoiDisplayNameFromTags(tags: Record<string, string>): string | null {
    const base = baseNameFromTags(tags);
    if (!base) return null;
    const branch = branchFromTags(tags);
    return branch ? `${base} | ${branch}` : base;
}

/** Label stored on the pick (`tags.name`) or the osm id fallback. */
export function poiDisplayName(poi: Poi): string {
    const stored = poi.tags['name']?.trim();
    if (stored) return stored;
    return poiOsmIdFallback(poi);
}

/** Fallback when no stored `name` tag exists. */
export function poiOsmIdFallback(poi: Poi): string {
    return `${poi.osm_type} ${poi.osm_id}`;
}

/** True when the pick still shows the osm id fallback, has no name,
 *  or has a `branch` not yet reflected in `tags.name`. */
export function poiNeedsNameRefresh(poi: Poi): boolean {
    if (poi.osm_type === 'node' && poi.osm_id === 0) return false;
    const stored = poi.tags['name']?.trim();
    if (!stored) return true;
    if (stored === poiOsmIdFallback(poi)) return true;
    const expected = formatPoiDisplayNameFromTags(poi.tags);
    return expected != null && expected !== stored;
}

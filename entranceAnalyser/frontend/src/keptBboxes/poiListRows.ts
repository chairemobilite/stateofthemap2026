/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Pure helpers for the POI list page: join kept bboxes with picks,
//! filter by Quebec/world scope, and derive display fields.

import type { KeptBbox, Poi, PoiPickEntry } from '../api';
import { poiDisplayName } from './poiDisplayName';
import { progressFromPoiPick, type ProgressStatus } from './progress';
import { isPointInQuebec } from './quebecBounds';

export type PoiListScope = 'world' | 'quebec';

export { poiDisplayName } from './poiDisplayName';

/** One started or completed POI row for the list table. */
export interface PoiListRow {
    bbox: KeptBbox;
    poi: Poi;
    pick: PoiPickEntry;
    status: ProgressStatus;
    inQuebec: boolean;
}

/** True when the pick has a real POI and is started or completed. */
export function isStartedOrCompletedPick(pick: PoiPickEntry | undefined): pick is PoiPickEntry & {
    poi: Poi;
} {
    if (!pick?.poi) return false;
    const status = progressFromPoiPick(pick.poi, false, pick.completed);
    return status === 'active' || status === 'completed';
}

/**
 * Join kept bboxes with cached picks and keep only started/completed POIs.
 *
 * @param keptBboxes - Every persisted kept cell.
 * @param picks      - Cached pick rows keyed by bbox id.
 */
export function buildPoiListRows(
    keptBboxes: KeptBbox[],
    picks: Record<string, PoiPickEntry>,
): PoiListRow[] {
    const rows: PoiListRow[] = [];
    for (const bbox of keptBboxes) {
        const pick = picks[bbox.id];
        if (!isStartedOrCompletedPick(pick)) continue;
        const [lon, lat] = bbox.center;
        rows.push({
            bbox,
            poi: pick.poi,
            pick,
            status: progressFromPoiPick(pick.poi, false, pick.completed),
            inQuebec: isPointInQuebec(lon, lat),
        });
    }
    return rows.sort((a, b) => poiDisplayName(a.poi).localeCompare(poiDisplayName(b.poi)));
}

/**
 * Filter list rows to one geographic scope.
 *
 * @param rows  - Output of {@link buildPoiListRows}.
 * @param scope - `quebec` keeps Quebec centres; `world` keeps the rest.
 */
export function filterPoiListRowsByScope(rows: PoiListRow[], scope: PoiListScope): PoiListRow[] {
    return scope === 'quebec' ? rows.filter((r) => r.inQuebec) : rows.filter((r) => !r.inQuebec);
}

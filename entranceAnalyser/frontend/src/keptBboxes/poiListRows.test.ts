/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import type { KeptBbox, Poi, PoiPickEntry } from '../api';
import {
    buildPoiListRows,
    filterPoiListRowsByScope,
    isStartedOrCompletedPick,
    poiDisplayName,
} from './poiListRows';

function makeBbox(id: string, lon: number, lat: number): KeptBbox {
    return {
        id,
        west: lon - 0.01,
        south: lat - 0.01,
        east: lon + 0.01,
        north: lat + 0.01,
        center: [lon, lat],
        cell_size_km: 1,
        population: 100,
        density_per_km2: 100,
        max_density_ratio: 0.1,
        built_volume: 0,
        max_built_volume_ratio: 0,
        kept_at: '2026-01-01T00:00:00Z',
    };
}

function makePoi(name: string): Poi {
    return {
        osm_type: 'way',
        osm_id: 42,
        center: [-73.5, 45.5],
        tags: { name },
        group: 'amenities',
    };
}

function makePick(poi: Poi | null, completed: boolean): PoiPickEntry {
    return { poi, completed, rejected: false, rejected_reason: null, place_type: null };
}

describe('poiListRows', () => {
    it.each([
        [makePick(makePoi('A'), false), true],
        [makePick(makePoi('B'), true), true],
        [makePick(null, false), false],
        [undefined, false],
    ] as const)('isStartedOrCompletedPick', (pick, expected) => {
        expect(isStartedOrCompletedPick(pick)).toBe(expected);
    });

    it('buildPoiListRows keeps started/completed picks and sorts by name', () => {
        const mtl = makeBbox('mtl', -73.5673, 45.5017);
        const tor = makeBbox('tor', -79.3832, 43.6532);
        const rows = buildPoiListRows(
            [mtl, tor],
            {
                mtl: makePick(makePoi('Zebra U'), false),
                tor: makePick(makePoi('Alpha Mall'), true),
            },
        );
        expect(rows.map((r) => r.bbox.id)).toEqual(['tor', 'mtl']);
        expect(rows[0]?.inQuebec).toBe(false);
        expect(rows[1]?.inQuebec).toBe(true);
    });

    it('filterPoiListRowsByScope splits Quebec and world', () => {
        const rows = buildPoiListRows(
            [makeBbox('q', -71.2, 46.8), makeBbox('w', -79.4, 43.7)],
            {
                q: makePick(makePoi('Quebec POI'), true),
                w: makePick(makePoi('World POI'), false),
            },
        );
        expect(filterPoiListRowsByScope(rows, 'quebec').map((r) => r.bbox.id)).toEqual(['q']);
        expect(filterPoiListRowsByScope(rows, 'world').map((r) => r.bbox.id)).toEqual(['w']);
    });

    it('poiDisplayName falls back to osm id', () => {
        const poi = makePoi('');
        delete poi.tags.name;
        expect(poiDisplayName(poi)).toBe('way 42');
    });
});

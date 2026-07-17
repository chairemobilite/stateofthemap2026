/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import type { Poi } from '../api';
import {
    formatPoiDisplayNameFromTags,
    poiDisplayName,
    poiNeedsNameRefresh,
} from './poiDisplayName';

function makePoi(tags: Record<string, string>, osmId = 42): Poi {
    return {
        osm_type: 'way',
        osm_id: osmId,
        center: [-73.5, 45.5],
        tags,
        group: 'amenities',
    };
}

describe('poiDisplayName', () => {
    it('formats name and branch', () => {
        expect(
            formatPoiDisplayNameFromTags({ name: 'UQTR', branch: 'Drummondville' }),
        ).toBe('UQTR | Drummondville');
    });

    it('reads stored composite name', () => {
        const poi = makePoi({ name: 'UQAM | Campus Longueuil' });
        expect(poiDisplayName(poi)).toBe('UQAM | Campus Longueuil');
    });

    it('falls back to osm id', () => {
        const poi = makePoi({});
        expect(poiDisplayName(poi)).toBe('way 42');
        expect(poiNeedsNameRefresh(poi)).toBe(true);
    });

    it('detects when branch is not yet in the stored name', () => {
        const poi = makePoi({ name: 'UQTR', branch: 'Drummondville' });
        expect(poiNeedsNameRefresh(poi)).toBe(true);
    });

    it('detects when refresh is not needed', () => {
        const poi = makePoi({ name: 'Université Laval' });
        expect(poiNeedsNameRefresh(poi)).toBe(false);
    });
});

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import { parseLatLonPairInput } from './customCentroidParse';

describe('parseLatLonPairInput', () => {
    it.each([
        ['45.5, -73.5', 45.5, -73.5],
        ['45.5/-73.5', 45.5, -73.5],
        ['  45.5  ,  -73.5  ', 45.5, -73.5],
        ['45.5 / -73.5', 45.5, -73.5],
        ['-33.9,151.2', -33.9, 151.2],
        ['0,0', 0, 0],
    ] as const)('%j → lat %s lon %s', (raw, lat, lon) => {
        const r = parseLatLonPairInput(raw);
        expect(r).toEqual({ lat, lon });
    });

    it.each([
        ['', /Enter latitude/],
        ['   ', /Enter latitude/],
        ['45.5', /comma or slash/],
        ['45.5 45.5', /comma or slash/],
        ['45.5,, -73', /numeric/],
        ['x, 1', /numeric/],
        ['91, 0', /Latitude must/],
        ['0, 181', /Longitude must/],
    ] as const)('%j → error matching %s', (raw, pattern) => {
        expect(parseLatLonPairInput(raw)).toMatchObject({ error: expect.stringMatching(pattern) });
    });
});

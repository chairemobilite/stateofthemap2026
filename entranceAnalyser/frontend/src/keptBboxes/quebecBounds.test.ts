/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import { isPointInQuebec } from './quebecBounds';

describe('isPointInQuebec', () => {
    it.each([
        ['Montreal', -73.5673, 45.5017, true],
        ['Quebec City', -71.208, 46.8139, true],
        ['Toronto', -79.3832, 43.6532, false],
        ['Paris', 2.3522, 48.8566, false],
    ] as const)('%s (%s, %s) → %s', (_label, lon, lat, expected) => {
        expect(isPointInQuebec(lon, lat)).toBe(expected);
    });
});

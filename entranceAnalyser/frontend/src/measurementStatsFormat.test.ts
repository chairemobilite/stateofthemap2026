/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, it, expect } from 'vitest';

import { formatMinutesSeconds } from './measurementStatsFormat';

describe('formatMinutesSeconds', () => {
    it('formats whole minutes and seconds', () => {
        expect(formatMinutesSeconds(192)).toBe('3m 12s');
    });

    it('rounds fractional seconds before splitting', () => {
        expect(formatMinutesSeconds(192.4)).toBe('3m 12s');
        expect(formatMinutesSeconds(192.6)).toBe('3m 13s');
    });

    it('returns em dash for non-finite', () => {
        expect(formatMinutesSeconds(NaN)).toBe('—');
    });
});

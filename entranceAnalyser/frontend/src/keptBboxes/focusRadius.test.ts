/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import {
    FOCUS_RADIUS_DEFAULT_M,
    FOCUS_RADIUS_MAX_M,
    FOCUS_RADIUS_MIN_M,
    parseFocusRadiusInput,
} from './focusRadius';

describe('parseFocusRadiusInput', () => {
    // Pure validator behind the radius `<input>` in the focus header.
    // The full request shape (including the `?radius_m=` URL param)
    // is covered by the cargo-side integration test; this suite only
    // locks in the client-side first line of defence.
    it.each([
        // Happy paths: floor, ceiling, server default, typical override,
        // tolerant of surrounding whitespace.
        [`${FOCUS_RADIUS_MIN_M}`, FOCUS_RADIUS_MIN_M],
        [`${FOCUS_RADIUS_MAX_M}`, FOCUS_RADIUS_MAX_M],
        [`${FOCUS_RADIUS_DEFAULT_M}`, FOCUS_RADIUS_DEFAULT_M],
        ['  300  ', 300],
        // Rejected inputs: empty, non-integer, out of range, garbage.
        ['', null],
        ['   ', null],
        ['9', null], // below floor
        ['2001', null], // above ceiling
        ['12.5', null], // non-integer
        ['abc', null],
        ['NaN', null],
    ] as const)('parseFocusRadiusInput(%j) → %j', (raw, expected) => {
        expect(parseFocusRadiusInput(raw)).toBe(expected);
    });
});

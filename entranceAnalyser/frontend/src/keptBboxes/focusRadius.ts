/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

/**
 * Constants and pure helpers for the focus-map radius input.
 *
 * Lives outside `PoiFocusMap.tsx` so the component file stays
 * component-only (react-refresh rule) and so the validator can be
 * unit-tested without the MapLibre / DOM bootstrap.
 */

/**
 * Mirror of `POI_FOCUS_RADIUS_MIN_M` / `POI_FOCUS_RADIUS_MAX_M` in
 * `backend/src/api.rs`. Keep in sync — the backend will reject
 * values outside this range, so the input's `min`/`max` attributes
 * are the first line of defence to spare users a round-trip.
 */
export const FOCUS_RADIUS_MIN_M = 10;
export const FOCUS_RADIUS_MAX_M = 2000;

/**
 * UI fallback used when no cached focus exists yet for the current
 * bbox. Mirrors the backend's `DEFAULT_POI_FOCUS_RADIUS_M = 150` in
 * `backend/src/main.rs`. Once a runtime `/api/config` endpoint
 * exposes the active server default this constant should source
 * from there instead of being duplicated.
 */
export const FOCUS_RADIUS_DEFAULT_M = 150;

/**
 * Validate a radius input string against the documented
 * `[FOCUS_RADIUS_MIN_M, FOCUS_RADIUS_MAX_M]` range. Returns the
 * parsed integer when accepted, or `null` for empty / non-numeric /
 * non-integer / out-of-range inputs.
 *
 * @param raw - Raw `<input>` value, typically a string of digits.
 */
export function parseFocusRadiusInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (n < FOCUS_RADIUS_MIN_M || n > FOCUS_RADIUS_MAX_M) return null;
    return n;
}

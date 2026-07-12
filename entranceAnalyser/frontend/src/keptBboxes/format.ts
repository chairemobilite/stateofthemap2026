/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Formatting helpers scoped to the kept-bboxes view. Intentionally
//! duplicated (not extracted from `SamplingPanel.tsx`) to avoid churn on
//! an already-committed file; a future refactor can DRY them up.

/** 4-decimal degrees with N/S or E/W suffix; matches SamplingPanel. */
export function formatCoord(value: number, axis: 'lat' | 'lon'): string {
    const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

/** Thousand-separator integer for populations and built volumes. */
export const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** One-decimal float for densities (people / km²); mirrors SamplingPanel. */
export const DENSITY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Percent with one decimal for ratios against the densest grid cell;
 *  mirrors SamplingPanel. */
export const PERCENT = new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
});

/** Locale date (no time) for `kept_at` timestamps in list rows. */
export function formatKeptDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

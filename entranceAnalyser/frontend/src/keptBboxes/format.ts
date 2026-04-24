//! Formatting helpers scoped to the kept-bboxes view. Intentionally
//! duplicated (not extracted from `SamplingPanel.tsx`) to avoid churn on
//! an already-committed file; a future refactor can DRY them up.

/** 4-decimal degrees with N/S or E/W suffix; matches SamplingPanel. */
export function formatCoord(value: number, axis: 'lat' | 'lon'): string {
    const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

/** Thousand-separator integer for populations. */
export const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Locale date (no time) for `kept_at` timestamps in list rows. */
export function formatKeptDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

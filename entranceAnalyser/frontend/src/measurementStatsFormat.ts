/**
 * Format a duration in seconds as `Xm YYs` for table readability.
 * Negative values preserve a leading minus on minutes.
 *
 * @param totalSeconds - Raw seconds (may be fractional from averages)
 */
export function formatMinutesSeconds(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds)) return '—';
    const sign = totalSeconds < 0 ? '-' : '';
    const s = Math.round(Math.abs(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${sign}${m}m ${sec.toString().padStart(2, '0')}s`;
}

/**
 * Split a one-line paste on the first comma or slash (maps / GPS often emit
 * `lat,lon` or `lat/lon`). Later commas in the string are not treated as
 * separators so fractional formats stay valid.
 */
function splitLatLonPaste(trimmed: string): [string, string] | null {
    let sep = -1;
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (c === ',' || c === '/') {
            sep = i;
            break;
        }
    }
    if (sep < 0) return null;
    const a = trimmed.slice(0, sep).trim();
    const b = trimmed.slice(sep + 1).trim();
    if (!a || !b) return null;
    return [a, b];
}

/**
 * Parse a pasted WGS84 pair as **latitude, then longitude**, separated by
 * `,` or `/` (optional spaces). Matches common copy-paste from consumer maps.
 *
 * @param raw - Single-line user input
 * @returns Parsed `{ lat, lon }` or `{ error }` for inline form display
 */
export function parseLatLonPairInput(raw: string): { lat: number; lon: number } | { error: string } {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { error: 'Enter latitude and longitude (e.g. 45.5, −73.5).' };
    }
    const parts = splitLatLonPaste(trimmed);
    if (parts === null) {
        return {
            error: 'Separate latitude and longitude with a comma or slash (e.g. 45.5, −73.5).',
        };
    }
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return { error: 'Enter numeric latitude and longitude.' };
    }
    if (lat < -90 || lat > 90) {
        return { error: 'Latitude must be between −90 and 90.' };
    }
    if (lon < -180 || lon > 180) {
        return { error: 'Longitude must be between −180 and 180.' };
    }
    return { lat, lon };
}

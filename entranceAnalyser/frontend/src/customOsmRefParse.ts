import type { OsmType } from './api';

/**
 * Parse `node/123`, `way/456`, or `relation/789` (optional spaces).
 *
 * @param raw - User paste from OSM URLs or editors
 * @returns Parsed type and numeric id, or an error message for inline display
 */
export function parseOsmRef(raw: string): { osm_type: OsmType; osm_id: number } | { error: string } {
    const s = raw.trim();
    const slash = s.indexOf('/');
    if (slash < 0) {
        return { error: 'Expected node/123, way/456, or relation/789.' };
    }
    const kind = s.slice(0, slash).trim().toLowerCase();
    const idPart = s.slice(slash + 1).trim();
    const osm_id = Number(idPart);
    if (!Number.isFinite(osm_id) || !Number.isInteger(osm_id) || osm_id <= 0) {
        return { error: 'OSM id must be a positive integer.' };
    }
    const osm_type: OsmType | null =
        kind === 'node' ? 'node' : kind === 'way' ? 'way' : kind === 'relation' ? 'relation' : null;
    if (!osm_type) {
        return { error: 'Type must be node, way, or relation.' };
    }
    return { osm_type, osm_id };
}

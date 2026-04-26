/**
 * Infer where a measurement’s first vertex is anchored (POI/focus centre,
 * OSM entrance, building polygon centroid, or unsnapped) so POST/PATCH
 * bodies match DB analytics columns.
 */

import type { FeatureCollection, Point } from 'geojson';

import type { PoiFocusResult } from '../api';
import { type AnchorScreenProjectFn, pixelDistance } from './measure';
import { buildingCentroidSnapsFromBuildings } from './poiFocusGeoJson';

/** Values the API accepts on write (`legacy_unknown` is read-only from DB). */
export type MeasurementStartOriginWire =
    | 'poi_focus_centroid'
    | 'osm_entrance'
    | 'building_centroid'
    | 'unsnapped_start';

export interface InferredMeasurementStart {
    start_origin: MeasurementStartOriginWire;
    /** OSM node id (`osm_entrance`) or OSM way id (`building_centroid`); otherwise `null`. */
    start_osm_node_id: number | null;
}

/**
 * Screen-space context for classifying the first vertex — must match the map
 * transform used when the user placed the point (`map.project` at save time).
 */
export interface AnchorSnapContext {
    /** Typically `map.project({ lng: first[0], lat: first[1] })`. */
    clickScreen: { x: number; y: number };
    project: AnchorScreenProjectFn;
    snapPx: number;
}

/**
 * Parse `node/123` from a GeoJSON Feature `id` (focus entrance features).
 *
 * @param featureId - GeoJSON `Feature.id` from the focus map
 * @returns Numeric OSM id, or `null` if not a `node/…` id
 */
export function parseOsmNodeIdFromFeatureId(featureId: unknown): number | null {
    if (typeof featureId !== 'string') return null;
    const m = /^node\/(\d+)$/.exec(featureId);
    if (!m) return null;
    return Number(m[1]);
}

function entranceSnapTargets(entrances: FeatureCollection | undefined): ReadonlyArray<{
    lon: number;
    lat: number;
    osmNodeId: number;
}> {
    if (!entrances?.features?.length) return [];
    const out: { lon: number; lat: number; osmNodeId: number }[] = [];
    for (const f of entrances.features) {
        if (f.geometry.type !== 'Point') continue;
        const id = parseOsmNodeIdFromFeatureId(f.id);
        if (id === null) continue;
        const c = (f.geometry as Point).coordinates;
        out.push({ lon: c[0], lat: c[1], osmNodeId: id });
    }
    return out;
}

/**
 * Classify the first vertex using the same pixel budget as the map: focus
 * centre, then nearest entrance, then nearest building polygon centroid;
 * otherwise `unsnapped_start` (entrances may be missing in OSM).
 *
 * @param poiFocusCenter - `focus.center` (or picked POI centre before focus loads)
 * @param entrances - `focus.entrances` collection from Overpass
 * @param buildings - `focus.buildings` polygon collection from Overpass
 * @param snap - First vertex in screen space (`map.project` of draft start) + same `project`/`snapPx` as map clicks
 */
export function inferMeasurementStart(
    poiFocusCenter: [number, number],
    entrances: FeatureCollection | undefined,
    buildings: PoiFocusResult['buildings'] | undefined,
    snap: AnchorSnapContext,
): InferredMeasurementStart {
    if (pixelDistance(snap.clickScreen, snap.project(poiFocusCenter[0], poiFocusCenter[1])) <= snap.snapPx) {
        return { start_origin: 'poi_focus_centroid', start_osm_node_id: null };
    }
    const entranceTargets = entranceSnapTargets(entrances);
    let bestEntranceId: number | null = null;
    let bestEntrancePx = snap.snapPx + 1;
    for (const t of entranceTargets) {
        const d = pixelDistance(snap.clickScreen, snap.project(t.lon, t.lat));
        if (d <= snap.snapPx && d < bestEntrancePx) {
            bestEntrancePx = d;
            bestEntranceId = t.osmNodeId;
        }
    }
    if (bestEntranceId !== null) {
        return { start_origin: 'osm_entrance', start_osm_node_id: bestEntranceId };
    }
    const buildingTargets = buildingCentroidSnapsFromBuildings(buildings);
    let bestWayId: number | null = null;
    let bestWayPx = snap.snapPx + 1;
    for (const t of buildingTargets) {
        const d = pixelDistance(snap.clickScreen, snap.project(t.lon, t.lat));
        if (d <= snap.snapPx && d < bestWayPx) {
            bestWayPx = d;
            bestWayId = t.wayId;
        }
    }
    if (bestWayId !== null) {
        return { start_origin: 'building_centroid', start_osm_node_id: bestWayId };
    }
    return { start_origin: 'unsnapped_start', start_osm_node_id: null };
}

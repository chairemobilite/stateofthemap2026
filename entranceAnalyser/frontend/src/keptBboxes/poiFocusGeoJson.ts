//! Pure helpers turning a `PoiFocusResult` plus its host POI into the
//! GeoJSON shapes the focus map needs. Kept separate from the
//! `PoiFocusMap` component so the geometry stays unit-testable without
//! pulling in MapLibre, matching the split that already exists for
//! `keptBboxesGeoJson`.

import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';

import type {
    FocusFeatureCollection,
    Poi,
    PoiFocusResult,
} from '../api';

/** Mean meters per degree of latitude on a spherical earth. Same
 *  constant the GHS rasters were resampled with, accurate enough for
 *  a sub-kilometre buffer ring. */
const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Buildings as a Polygon `FeatureCollection`. The backend has already
 * closed every ring and discarded relations, so this is a structural
 * cast — exposed as a function so consumers don't reach into the API
 * type tree directly.
 */
export function toBuildingsCollection(
    focus: PoiFocusResult,
): FeatureCollection<Polygon> {
    return castFocusCollection(focus.buildings) as FeatureCollection<Polygon>;
}

/**
 * Entrance nodes as a Point `FeatureCollection`. Mirrors
 * `toBuildingsCollection`; kept symmetric so the component is symmetric
 * and the two layers can share configuration.
 */
export function toEntrancesCollection(
    focus: PoiFocusResult,
): FeatureCollection<Point> {
    return castFocusCollection(focus.entrances) as FeatureCollection<Point>;
}

/**
 * `[lon, lat]` for every entrance Point in `focus` (for measurement snap).
 *
 * @param focus Loaded focus result, or `undefined` before fetch completes
 */
export function entranceCentersFromFocus(focus: PoiFocusResult | undefined): [number, number][] {
    if (!focus?.entrances?.features?.length) return [];
    const out: [number, number][] = [];
    for (const f of focus.entrances.features) {
        if (f.geometry.type !== 'Point') continue;
        const c = f.geometry.coordinates;
        out.push([c[0], c[1]]);
    }
    return out;
}

/**
 * Parse `way/123` from a GeoJSON Feature `id` (focus building polygons).
 *
 * @param featureId - GeoJSON `Feature.id` from the focus map
 * @returns Numeric OSM way id, or `null` if not a `way/…` id
 */
export function parseOsmWayIdFromFeatureId(featureId: unknown): number | null {
    if (typeof featureId !== 'string') return null;
    const m = /^way\/(\d+)$/.exec(featureId);
    if (!m) return null;
    return Number(m[1]);
}

/**
 * Planar polygon centroid of one closed ring in lon/lat (fine for
 * building-sized rings; matches analytics need for a stable anchor).
 *
 * @param ring - Outer ring `coordinates[0]` from GeoJSON, closed or open
 */
export function polygonOuterRingCentroid(ring: [number, number][]): [number, number] {
    const n = ring.length;
    if (n === 0) return [0, 0];
    if (n === 1) return [ring[0][0], ring[0][1]];
    const last = ring[n - 1];
    const first = ring[0];
    const open =
        first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : [...ring];
    const m = open.length;
    if (m < 3) {
        let sx = 0;
        let sy = 0;
        for (const p of open) {
            sx += p[0];
            sy += p[1];
        }
        return [sx / m, sy / m];
    }
    let twice = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = m - 1; i < m; j = i++) {
        const [x0, y0] = open[j];
        const [x1, y1] = open[i];
        const cross = x0 * y1 - x1 * y0;
        twice += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    const a = twice / 2;
    if (Math.abs(a) < 1e-18) {
        let sx = 0;
        let sy = 0;
        for (const p of open) {
            sx += p[0];
            sy += p[1];
        }
        return [sx / m, sy / m];
    }
    return [cx / (6 * a), cy / (6 * a)];
}

/** One building polygon centroid for measurement snap / map layer. */
export interface BuildingCentroidSnap {
    lon: number;
    lat: number;
    wayId: number;
}

/**
 * Centroid of each Polygon building in the focus `buildings` collection.
 *
 * @param buildings - `focus.buildings` from the API, or `undefined`
 */
export function buildingCentroidSnapsFromBuildings(
    buildings: PoiFocusResult['buildings'] | undefined,
): BuildingCentroidSnap[] {
    if (!buildings?.features?.length) return [];
    const out: BuildingCentroidSnap[] = [];
    for (const f of buildings.features) {
        if (f.geometry.type !== 'Polygon') continue;
        const wayId = parseOsmWayIdFromFeatureId(f.id);
        if (wayId === null) continue;
        const outer = f.geometry.coordinates[0] as [number, number][] | undefined;
        if (!outer?.length) continue;
        const [lon, lat] = polygonOuterRingCentroid(outer);
        out.push({ lon, lat, wayId });
    }
    return out;
}

/** `[lon, lat]` for each building centroid (first-vertex snap targets). */
export function buildingCentroidPointsForSnap(focus: PoiFocusResult | undefined): [number, number][] {
    return buildingCentroidSnapsFromBuildings(focus?.buildings).map((b) => [b.lon, b.lat]);
}

/**
 * Point markers at building centroids (grey), for choosing a main
 * building when the POI node sits inside the polygon.
 */
export function toBuildingCentroidsCollection(focus: PoiFocusResult): FeatureCollection<Point> {
    const snaps = buildingCentroidSnapsFromBuildings(focus.buildings);
    return {
        type: 'FeatureCollection',
        features: snaps.map((b) => ({
            type: 'Feature' as const,
            id: `way/${b.wayId}`,
            properties: { way_id: b.wayId },
            geometry: { type: 'Point' as const, coordinates: [b.lon, b.lat] },
        })),
    };
}

/**
 * Picked POI centre as a single-feature collection so MapLibre can
 * paint it on the focus map with its own colour. Properties echo
 * `osm_type` / `osm_id` / `group` for click-through inspection.
 *
 * `pickCompleted` and `pickRejected` are mutually exclusive (the
 * server enforces this) and drive the marker colour:
 *   - `completed = true`  → green
 *   - `rejected  = true`  → red (POI flagged as unusable)
 *   - otherwise           → orange (pending)
 */
export function toPickedPoiCollection(
    poi: Poi,
    pickCompleted = false,
    pickRejected = false,
): FeatureCollection<Point> {
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {
                    bbox_picked: true,
                    osm_type: poi.osm_type,
                    osm_id: poi.osm_id,
                    group: poi.group,
                    completed: pickCompleted,
                    rejected: pickRejected,
                },
                geometry: { type: 'Point', coordinates: poi.center },
            },
        ],
    };
}

/**
 * Approximate the `radius_m` buffer around `center` as a closed
 * `LineString` of `vertices` points. Drawn as a stroke (not a fill) so
 * the underlying basemap stays readable, and computed in degrees with
 * a flat-earth approximation that's accurate to <1 m at radii up to a
 * few kilometres.
 *
 * @param center - `[lon, lat]` GeoJSON coordinate of the picked POI.
 * @param radiusM - Buffer radius in metres, server-config'd.
 * @param vertices - Resolution of the polygon approximation. 64 keeps
 *   the ring visually round at any zoom inside MapLibre's render budget.
 */
export function toBufferRing(
    center: [number, number],
    radiusM: number,
    vertices = 64,
): Feature<LineString> {
    const [lon, lat] = center;
    const latRad = (lat * Math.PI) / 180;
    const dLat = radiusM / METERS_PER_DEGREE_LAT;
    const dLon = radiusM / (METERS_PER_DEGREE_LAT * Math.cos(latRad));
    const coordinates: [number, number][] = [];
    for (let i = 0; i <= vertices; i++) {
        const angle = (i / vertices) * 2 * Math.PI;
        coordinates.push([lon + dLon * Math.cos(angle), lat + dLat * Math.sin(angle)]);
    }
    return {
        type: 'Feature',
        properties: { radius_m: radiusM },
        geometry: { type: 'LineString', coordinates },
    };
}

/**
 * MapLibre fitBounds-friendly envelope of the focus, computed off the
 * buffer ring. Using the ring (instead of the buildings) keeps the
 * initial framing stable even when Overpass returned no buildings.
 */
export function toFocusBounds(
    center: [number, number],
    radiusM: number,
): [[number, number], [number, number]] {
    const [lon, lat] = center;
    const latRad = (lat * Math.PI) / 180;
    const dLat = radiusM / METERS_PER_DEGREE_LAT;
    const dLon = radiusM / (METERS_PER_DEGREE_LAT * Math.cos(latRad));
    return [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat + dLat],
    ];
}

/** Strip the wire `FocusFeatureCollection` into the GeoJSON-typed shape
 *  the `geojson` package expects. The shapes are structurally
 *  compatible — only the geometry discriminant types differ. */
function castFocusCollection(collection: FocusFeatureCollection): FeatureCollection {
    return collection as unknown as FeatureCollection;
}

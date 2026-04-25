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
 * Picked POI centre as a single-feature collection so MapLibre can
 * paint it on the focus map with its own colour. Properties echo
 * `osm_type` / `osm_id` / `group` for click-through inspection.
 */
export function toPickedPoiCollection(poi: Poi): FeatureCollection<Point> {
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

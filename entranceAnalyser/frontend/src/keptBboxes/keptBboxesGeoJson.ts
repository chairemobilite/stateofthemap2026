//! Pure helpers turning a list of kept bboxes into the GeoJSON sources
//! and MapLibre bounds the overview map needs. Kept separate from
//! `KeptBboxesMap` so the geometry is unit-testable without pulling in
//! MapLibre.

import type { FeatureCollection, Point, Polygon } from 'geojson';
import type { LngLatBoundsLike } from 'maplibre-gl';

import type { KeptBbox, PoiPickEntry } from '../api';
import { toPolygon } from '../bboxGeoJson';

/**
 * Build a `FeatureCollection` of Polygon outlines, one per kept bbox.
 * Reuses `toPolygon` so rectangles match the sampling map byte-for-byte.
 */
export function toPolygonCollection(keptBboxes: KeptBbox[]): FeatureCollection<Polygon> {
    return {
        type: 'FeatureCollection',
        features: keptBboxes.map(toPolygon),
    };
}

/**
 * Build a `FeatureCollection` of center Points, one per kept bbox, for
 * the circle-marker layer shown at low zoom. `properties.id` mirrors the
 * polygon layer so click handlers can look up the full `KeptBbox` from
 * either source.
 */
export function toCenterCollection(keptBboxes: KeptBbox[]): FeatureCollection<Point> {
    return {
        type: 'FeatureCollection',
        features: keptBboxes.map((bbox) => ({
            type: 'Feature',
            id: bbox.id,
            properties: { id: bbox.id },
            geometry: { type: 'Point', coordinates: bbox.center },
        })),
    };
}

/**
 * Build a `FeatureCollection` of picked POI centers, one per non-null
 * entry in `picks`. Skips bboxes with `null` poi (queried but empty) and
 * missing keys (no row yet) so the marker layer paints only real
 * features. The `completed` and `rejected` flags drive the marker
 * colour on the overview map (green / red / orange respectively).
 * `properties.bbox_id` lets click handlers look up the host bbox.
 */
export function toPoiCollection(picks: Record<string, PoiPickEntry>): FeatureCollection<Point> {
    const features: FeatureCollection<Point>['features'] = [];
    for (const [bboxId, entry] of Object.entries(picks)) {
        if (!entry.poi) continue;
        const poi = entry.poi;
        features.push({
            type: 'Feature',
            properties: {
                bbox_id: bboxId,
                osm_type: poi.osm_type,
                osm_id: poi.osm_id,
                group: poi.group,
                completed: entry.completed,
                rejected: entry.rejected,
            },
            geometry: { type: 'Point', coordinates: poi.center },
        });
    }
    return { type: 'FeatureCollection', features };
}

/**
 * Collective envelope of the given bboxes in the format MapLibre's
 * `fitBounds` expects. Returns `null` when the list is empty so the
 * caller can keep the default world-level view.
 */
export function toCollectiveBounds(keptBboxes: KeptBbox[]): LngLatBoundsLike | null {
    if (keptBboxes.length === 0) return null;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const b of keptBboxes) {
        if (b.west < west) west = b.west;
        if (b.south < south) south = b.south;
        if (b.east > east) east = b.east;
        if (b.north > north) north = b.north;
    }
    return [
        [west, south],
        [east, north],
    ];
}

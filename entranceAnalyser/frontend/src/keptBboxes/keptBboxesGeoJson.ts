//! Pure helpers turning a list of kept bboxes into the GeoJSON sources
//! and MapLibre bounds the overview map needs. Kept separate from
//! `KeptBboxesMap` so the geometry is unit-testable without pulling in
//! MapLibre.

import type { FeatureCollection, Point, Polygon } from 'geojson';
import type { LngLatBoundsLike } from 'maplibre-gl';

import type { KeptBbox } from '../api';
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

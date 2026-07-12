/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Pure helpers that turn a backend `Bbox` into the GeoJSON and bounds
//! that MapLibre needs. Kept out of `MapView` so the geometry can be
//! unit-tested without pulling in the map.

import type { LngLatBoundsLike } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';

import type { Bbox } from './api';

/**
 * Build a GeoJSON Polygon feature for the bbox. The ring is closed
 * (first point repeated as last), walked counter-clockwise starting
 * from the south-west corner.
 */
export function toPolygon(bbox: Bbox): Feature<Polygon> {
    const { west, south, east, north, id } = bbox;
    return {
        type: 'Feature',
        id,
        properties: { id },
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [west, south],
                    [east, south],
                    [east, north],
                    [west, north],
                    [west, south],
                ],
            ],
        },
    };
}

/** Return the bbox as the `[[minLng, minLat], [maxLng, maxLat]]` tuple
 *  MapLibre's `fitBounds` expects. */
export function toBounds(bbox: Bbox): LngLatBoundsLike {
    return [
        [bbox.west, bbox.south],
        [bbox.east, bbox.north],
    ];
}

//! GeoJSON builders for persisted measurement LineStrings on the focus map.

import type { Feature, FeatureCollection, LineString } from 'geojson';

import type { PoiFocusMeasurement } from '../api';

/**
 * LineString features for every measurement in `measurements`, tagged
 * for MapLibre `queryRenderedFeatures` / `promoteId: 'measurement_id'`.
 *
 * Feature `properties` carry the same metadata as the API row so exports
 * and data-driven styling can distinguish e.g. `to_nearest_entrance` vs
 * `to_nearest_main_entrance`.
 */
export function toSavedMeasurementsFeatureCollection(
    measurements: PoiFocusMeasurement[],
): FeatureCollection<LineString> {
    const features: Feature<LineString>[] = measurements.map((m) => ({
        type: 'Feature',
        properties: {
            measurement_id: m.id,
            measurement_type: m.measurement_type,
            entrance_type: m.entrance_type,
            length_m: m.length_m,
            walking_speed_kmh: m.walking_speed_kmh,
            start_origin: m.start_origin,
        },
        geometry: {
            type: 'LineString',
            coordinates: m.coordinates,
        },
    }));
    return { type: 'FeatureCollection', features };
}

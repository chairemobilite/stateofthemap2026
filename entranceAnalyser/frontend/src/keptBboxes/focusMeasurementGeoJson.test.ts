import { describe, it, expect } from 'vitest';

import { toSavedMeasurementsFeatureCollection } from './focusMeasurementGeoJson';
import type { PoiFocusMeasurement } from '../api';

function sampleMeasurement(overrides: Partial<PoiFocusMeasurement> = {}): PoiFocusMeasurement {
    return {
        id: '00000000-0000-4000-8000-000000000001',
        bbox_id: '00000000-0000-4000-8000-000000000002',
        coordinates: [
            [-73.0, 45.0],
            [-73.01, 45.0],
        ],
        walking_speed_kmh: 5,
        length_m: 800,
        measurement_type: 'to_nearest_main_entrance',
        entrance_type: 'main',
        start_origin: 'poi_focus_centroid',
        start_osm_node_id: null,
        created_at: '2020-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('toSavedMeasurementsFeatureCollection', () => {
    it('puts API metadata on GeoJSON properties for styling and export', () => {
        const fc = toSavedMeasurementsFeatureCollection([sampleMeasurement()]);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].properties).toEqual({
            measurement_id: '00000000-0000-4000-8000-000000000001',
            measurement_type: 'to_nearest_main_entrance',
            entrance_type: 'main',
            length_m: 800,
            walking_speed_kmh: 5,
            start_origin: 'poi_focus_centroid',
        });
    });

    it('includes to_nearest_entrance when that purpose is stored', () => {
        const fc = toSavedMeasurementsFeatureCollection([
            sampleMeasurement({ measurement_type: 'to_nearest_entrance' }),
        ]);
        expect(fc.features[0].properties?.measurement_type).toBe('to_nearest_entrance');
    });
});

import { describe, expect, it } from 'vitest';

import type { PoiFocusMeasurement } from '../api';
import {
    aggregateDestinationWarningsByMessage,
    findMeasurementDestinationMismatches,
    measurementEndpoint,
    MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
} from './measurementDestinationWarnings';

function sample(
    overrides: Partial<PoiFocusMeasurement> & Pick<PoiFocusMeasurement, 'entrance_type'>,
): PoiFocusMeasurement {
    const { entrance_type, ...rest } = overrides;
    return {
        id: '00000000-0000-4000-8000-000000000001',
        bbox_id: '00000000-0000-4000-8000-000000000099',
        coordinates: [
            [-73.57, 45.5],
            [-73.569, 45.501],
        ],
        walking_speed_kmh: 5,
        length_m: 100,
        measurement_type: 'to_nearest_transit_stop',
        start_origin: 'osm_entrance',
        start_osm_node_id: 1,
        created_at: '2026-01-01T00:00:00Z',
        ...rest,
        entrance_type,
    };
}

describe('measurementDestinationWarnings', () => {
    it('uses the last coordinate as the destination endpoint', () => {
        expect(
            measurementEndpoint([
                [-73.57, 45.5],
                [-73.569, 45.501],
            ]),
        ).toEqual([-73.569, 45.501]);
    });

    it('returns empty when fewer than two entrance anchors exist for a purpose', () => {
        expect(
            findMeasurementDestinationMismatches([
                sample({ entrance_type: 'main' }),
            ]),
        ).toEqual([]);
    });

    it('warns when endpoints differ beyond the match radius', () => {
        const warnings = findMeasurementDestinationMismatches([
            sample({
                entrance_type: 'main',
                coordinates: [
                    [-73.57, 45.5],
                    [-73.569, 45.501],
                ],
            }),
            sample({
                entrance_type: 'centroid_main_building',
                coordinates: [
                    [-73.57, 45.5],
                    [-73.56, 45.502],
                ],
            }),
        ]);
        expect(warnings).toEqual([
            'The nearest transit stop is not the same for main building centroid and main entrance',
        ]);
    });

    it('does not warn when endpoints are within the match radius', () => {
        const base = [-73.569, 45.501] as [number, number];
        const nearby: [number, number] = [
            base[0] + 0.00001,
            base[1] + 0.00001,
        ];
        const warnings = findMeasurementDestinationMismatches([
            sample({ entrance_type: 'main', coordinates: [[-73.57, 45.5], base] }),
            sample({
                entrance_type: 'centroid_main_building',
                coordinates: [[-73.57, 45.5], nearby],
            }),
        ]);
        expect(warnings).toEqual([]);
    });

    it('respects a custom match radius', () => {
        const a: [number, number] = [-73.569, 45.501];
        const b: [number, number] = [-73.5691, 45.5011];
        const dist = 15;
        const warnings = findMeasurementDestinationMismatches(
            [
                sample({ entrance_type: 'main', coordinates: [[-73.57, 45.5], a] }),
                sample({
                    entrance_type: 'centroid_area',
                    coordinates: [[-73.57, 45.5], b],
                }),
            ],
            dist,
        );
        expect(warnings).toEqual([]);
    });

    it('ignores to_nearest_entrance and to_nearest_main_entrance purposes', () => {
        const warnings = findMeasurementDestinationMismatches([
            sample({
                entrance_type: 'main',
                measurement_type: 'to_nearest_entrance',
                coordinates: [[-73.57, 45.5], [-73.569, 45.501]],
            }),
            sample({
                entrance_type: 'centroid_main_building',
                measurement_type: 'to_nearest_entrance',
                coordinates: [[-73.57, 45.5], [-73.56, 45.502]],
            }),
        ]);
        expect(warnings).toEqual([]);
    });

    it('compares each comparable purpose independently', () => {
        const warnings = findMeasurementDestinationMismatches([
            sample({
                entrance_type: 'main',
                measurement_type: 'to_nearest_transit_stop',
                coordinates: [[-73.57, 45.5], [-73.569, 45.501]],
            }),
            sample({
                entrance_type: 'centroid_main_building',
                measurement_type: 'to_nearest_transit_stop',
                coordinates: [[-73.57, 45.5], [-73.56, 45.502]],
            }),
            sample({
                entrance_type: 'main',
                measurement_type: 'to_nearest_walking_network',
                coordinates: [[-73.57, 45.5], [-73.568, 45.5]],
                created_at: '2026-01-02T00:00:00Z',
            }),
            sample({
                entrance_type: 'centroid_main_building',
                measurement_type: 'to_nearest_walking_network',
                coordinates: [[-73.57, 45.5], [-73.568, 45.5]],
                created_at: '2026-01-02T00:00:00Z',
            }),
        ]);
        expect(warnings).toEqual([
            'The nearest transit stop is not the same for main building centroid and main entrance',
        ]);
    });

    it('uses the latest measurement per entrance type when duplicates exist', () => {
        const warnings = findMeasurementDestinationMismatches([
            sample({
                id: '00000000-0000-4000-8000-000000000001',
                entrance_type: 'main',
                coordinates: [[-73.57, 45.5], [-73.569, 45.501]],
                created_at: '2026-01-01T00:00:00Z',
            }),
            sample({
                id: '00000000-0000-4000-8000-000000000002',
                entrance_type: 'main',
                coordinates: [[-73.57, 45.5], [-73.568, 45.5]],
                created_at: '2026-01-03T00:00:00Z',
            }),
            sample({
                entrance_type: 'centroid_main_building',
                coordinates: [[-73.57, 45.5], [-73.568, 45.5]],
            }),
        ]);
        expect(warnings).toEqual([]);
    });

    it.each([
        MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
    ])('default match radius is %i m', (radius) => {
        expect(radius).toBe(10);
    });
});

describe('aggregateDestinationWarningsByMessage', () => {
    it('groups by message and sorts by descending POI count', () => {
        const msg =
            'The nearest transit stop is not the same for main building centroid and main entrance';
        const rows = aggregateDestinationWarningsByMessage([
            { bbox_id: 'b', warnings: [msg] },
            { bbox_id: 'a', warnings: [msg] },
            {
                bbox_id: 'c',
                warnings: ['The nearest parking is not the same for main entrance and area centroid'],
            },
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0].message).toBe(msg);
        expect(rows[0].bbox_ids).toEqual(['a', 'b']);
        expect(rows[0].bbox_ids).toHaveLength(2);
    });
});

import { describe, expect, it } from 'vitest';

import {
    inferMeasurementStart,
    parseOsmNodeIdFromFeatureId,
    type AnchorSnapContext,
} from './measurementStart';

describe('parseOsmNodeIdFromFeatureId', () => {
    it.each([
        ['node/42', 42],
        ['way/1', null],
        ['node/', null],
        ['', null],
        [123, null],
    ] as const)('%j → %s', (id, expected) => {
        expect(parseOsmNodeIdFromFeatureId(id)).toBe(expected);
    });
});

describe('inferMeasurementStart', () => {
    /** Linear `project` so ° distances map to “px”; scale keeps test coords >8px apart where needed. */
    const SNAP_TEST_SCALE = 10_000;

    function snapCtxForLngLat(first: [number, number], snapPx = 8): AnchorSnapContext {
        const project = (lon: number, lat: number) => ({
            x: lon * SNAP_TEST_SCALE,
            y: lat * SNAP_TEST_SCALE,
        });
        return {
            clickScreen: project(first[0], first[1]),
            project,
            snapPx,
        };
    }

    const center: [number, number] = [-73.55, 45.55];
    const entrancesFar = {
        type: 'FeatureCollection' as const,
        features: [
            {
                type: 'Feature' as const,
                id: 'node/9001',
                geometry: { type: 'Point' as const, coordinates: [-73.551, 45.551] },
                properties: {},
            },
        ],
    };

    const offsetBuilding = {
        type: 'FeatureCollection' as const,
        features: [
            {
                type: 'Feature' as const,
                id: 'way/7001',
                geometry: {
                    type: 'Polygon' as const,
                    coordinates: [
                        [
                            [-73.552, 45.551],
                            [-73.551, 45.551],
                            [-73.551, 45.552],
                            [-73.552, 45.552],
                            [-73.552, 45.551],
                        ],
                    ],
                },
                properties: {},
            },
        ],
    };

    it('returns poi_focus_centroid when the first vertex is within the centre guard', () => {
        const r = inferMeasurementStart(center, entrancesFar, undefined, snapCtxForLngLat(center));
        expect(r).toEqual({ start_origin: 'poi_focus_centroid', start_osm_node_id: null });
    });

    it('prefers centroid over an entrance at the same coordinates', () => {
        const entrancesCoincident = {
            type: 'FeatureCollection' as const,
            features: [
                {
                    type: 'Feature' as const,
                    id: 'node/9002',
                    geometry: { type: 'Point' as const, coordinates: [...center] as [number, number] },
                    properties: {},
                },
            ],
        };
        const r = inferMeasurementStart(center, entrancesCoincident, offsetBuilding, snapCtxForLngLat(center));
        expect(r).toEqual({ start_origin: 'poi_focus_centroid', start_osm_node_id: null });
    });

    it('returns osm_entrance when first point snaps to an entrance but not centroid', () => {
        const first: [number, number] = [-73.551, 45.551];
        const r = inferMeasurementStart(center, entrancesFar, offsetBuilding, snapCtxForLngLat(first));
        expect(r).toEqual({ start_origin: 'osm_entrance', start_osm_node_id: 9001 });
    });

    it('returns building_centroid when snapped to a building but not focus or entrance', () => {
        const first: [number, number] = [-73.5515, 45.5515];
        const r = inferMeasurementStart(center, undefined, offsetBuilding, snapCtxForLngLat(first));
        expect(r).toEqual({ start_origin: 'building_centroid', start_osm_node_id: 7001 });
    });

    it('prefers osm_entrance over building_centroid when both are in snap range', () => {
        const onEntrance: [number, number] = [-73.551, 45.551];
        const entrancesNearBuilding = {
            type: 'FeatureCollection' as const,
            features: [
                {
                    type: 'Feature' as const,
                    id: 'node/8001',
                    geometry: { type: 'Point' as const, coordinates: onEntrance },
                    properties: {},
                },
            ],
        };
        const r = inferMeasurementStart(
            center,
            entrancesNearBuilding,
            offsetBuilding,
            snapCtxForLngLat(onEntrance),
        );
        expect(r).toEqual({ start_origin: 'osm_entrance', start_osm_node_id: 8001 });
    });

    it('returns unsnapped_start when no anchor is in range', () => {
        const first: [number, number] = [-73.6, 45.6];
        expect(
            inferMeasurementStart(center, entrancesFar, offsetBuilding, snapCtxForLngLat(first)),
        ).toEqual({
            start_origin: 'unsnapped_start',
            start_osm_node_id: null,
        });
    });
});

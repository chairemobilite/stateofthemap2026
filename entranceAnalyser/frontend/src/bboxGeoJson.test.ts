import { describe, it, expect } from 'vitest';

import type { Bbox } from './api';
import { toBounds, toPolygon } from './bboxGeoJson';

const SAMPLE: Bbox = {
    id: '00000000-0000-0000-0000-000000000001',
    west: -73.6,
    south: 45.5,
    east: -73.5,
    north: 45.6,
    center: [-73.55, 45.55],
    population: null,
    filtered: false,
};

describe('bbox geojson', () => {
    it('toPolygon returns a closed five-point ring starting at the SW corner', () => {
        const feature = toPolygon(SAMPLE);
        expect(feature.type).toBe('Feature');
        expect(feature.id).toBe(SAMPLE.id);
        expect(feature.geometry.type).toBe('Polygon');

        const ring = feature.geometry.coordinates[0];
        expect(ring).toHaveLength(5);
        expect(ring[0]).toEqual([SAMPLE.west, SAMPLE.south]);
        expect(ring[4]).toEqual(ring[0]);
        expect(new Set(ring.map((p) => p.join(',')))).toEqual(
            new Set([
                `${SAMPLE.west},${SAMPLE.south}`,
                `${SAMPLE.east},${SAMPLE.south}`,
                `${SAMPLE.east},${SAMPLE.north}`,
                `${SAMPLE.west},${SAMPLE.north}`,
            ]),
        );
    });

    it('toBounds returns the [[minLng, minLat], [maxLng, maxLat]] pair expected by fitBounds', () => {
        expect(toBounds(SAMPLE)).toEqual([
            [SAMPLE.west, SAMPLE.south],
            [SAMPLE.east, SAMPLE.north],
        ]);
    });
});

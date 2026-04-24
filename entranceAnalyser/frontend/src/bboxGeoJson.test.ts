import { describe, it, expect } from 'vitest';

import { toBounds, toPolygon } from './bboxGeoJson';
import { makeBbox } from './test/fixtures';

const SAMPLE = makeBbox({ id: '00000000-0000-0000-0000-000000000001' });

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

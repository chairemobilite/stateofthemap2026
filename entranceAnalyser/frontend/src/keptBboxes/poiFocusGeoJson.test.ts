import { describe, expect, it } from 'vitest';

import { makePoi, makePoiFocus } from '../test/fixtures';
import {
    toBufferRing,
    toBuildingsCollection,
    toEntrancesCollection,
    toFocusBounds,
    toPickedPoiCollection,
} from './poiFocusGeoJson';

describe('poiFocusGeoJson', () => {
    it('toBuildingsCollection round-trips the wire features unchanged', () => {
        const focus = makePoiFocus();
        const out = toBuildingsCollection(focus);
        expect(out.type).toBe('FeatureCollection');
        expect(out.features).toHaveLength(1);
        expect(out.features[0].id).toBe('way/1');
        expect(out.features[0].geometry.type).toBe('Polygon');
    });

    it('toEntrancesCollection round-trips the wire features unchanged', () => {
        const focus = makePoiFocus();
        const out = toEntrancesCollection(focus);
        expect(out.features).toHaveLength(1);
        expect(out.features[0].id).toBe('node/2');
        expect(out.features[0].geometry).toEqual({
            type: 'Point',
            coordinates: [-73.55, 45.55],
        });
    });

    it('toPickedPoiCollection emits a single Point feature with provenance', () => {
        const poi = makePoi({ osm_id: 99, group: 'shops' });
        const out = toPickedPoiCollection(poi);
        expect(out.features).toHaveLength(1);
        const feature = out.features[0];
        expect(feature.geometry).toEqual({ type: 'Point', coordinates: poi.center });
        expect(feature.properties).toMatchObject({
            bbox_picked: true,
            osm_type: 'node',
            osm_id: 99,
            group: 'shops',
        });
    });

    it.each([
        [16, 16],
        [32, 32],
        [64, 64],
    ])('toBufferRing closes the ring at %i vertices', (vertices, expected) => {
        const ring = toBufferRing([-73.5, 45.5], 150, vertices);
        const coords = ring.geometry.coordinates;
        // Closed: first point repeated as last; total = vertices + 1.
        expect(coords).toHaveLength(expected + 1);
        expect(coords[0]).toEqual(coords[coords.length - 1]);
    });

    it('toBufferRing approximates the requested radius in metres', () => {
        const center: [number, number] = [-73.5, 45.5];
        const radius = 150;
        const ring = toBufferRing(center, radius, 64);
        // Vertex 0 lies due east of the centre — its longitude offset
        // should match radius / (111_320 * cos(lat)).
        const [lon0, lat0] = ring.geometry.coordinates[0];
        const expectedDLon = radius / (111_320 * Math.cos((45.5 * Math.PI) / 180));
        expect(lat0).toBeCloseTo(45.5, 6);
        expect(lon0 - center[0]).toBeCloseTo(expectedDLon, 6);
    });

    it('toFocusBounds is the bounding square of the buffer ring', () => {
        const center: [number, number] = [-73.5, 45.5];
        const bounds = toFocusBounds(center, 150);
        const ring = toBufferRing(center, 150, 64);

        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        for (const [lon, lat] of ring.geometry.coordinates) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        expect(bounds[0][0]).toBeCloseTo(minLon, 6);
        expect(bounds[0][1]).toBeCloseTo(minLat, 6);
        expect(bounds[1][0]).toBeCloseTo(maxLon, 6);
        expect(bounds[1][1]).toBeCloseTo(maxLat, 6);
    });
});

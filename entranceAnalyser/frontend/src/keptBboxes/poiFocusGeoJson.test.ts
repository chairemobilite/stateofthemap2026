import { describe, expect, it } from 'vitest';

import { makePoi, makePoiFocus } from '../test/fixtures';
import {
    buildingCentroidSnapsFromBuildings,
    entranceCentersFromFocus,
    parseOsmWayIdFromFeatureId,
    polygonOuterRingCentroid,
    toBufferRing,
    toBuildingsCollection,
    toBuildingCentroidsCollection,
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

    it('entranceCentersFromFocus collects Point coordinates', () => {
        const focus = makePoiFocus();
        expect(entranceCentersFromFocus(focus)).toEqual([[-73.55, 45.55]]);
        expect(entranceCentersFromFocus(undefined)).toEqual([]);
    });

    it.each([
        ['way/42', 42],
        ['node/1', null],
        ['way/', null],
        ['', null],
        [123, null],
    ] as const)('parseOsmWayIdFromFeatureId(%j) → %s', (id, expected) => {
        expect(parseOsmWayIdFromFeatureId(id)).toBe(expected);
    });

    it('polygonOuterRingCentroid matches the centre of an axis-aligned square', () => {
        const ring: [number, number][] = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
        ];
        const [lon, lat] = polygonOuterRingCentroid(ring);
        expect(lon).toBeCloseTo(0.5, 6);
        expect(lat).toBeCloseTo(0.5, 6);
    });

    it('buildingCentroidSnapsFromBuildings returns one snap per polygon way', () => {
        const focus = makePoiFocus();
        const snaps = buildingCentroidSnapsFromBuildings(focus.buildings);
        expect(snaps).toHaveLength(1);
        expect(snaps[0].wayId).toBe(1);
        expect(snaps[0].lon).toBeCloseTo(-73.55, 5);
        expect(snaps[0].lat).toBeCloseTo(45.55, 5);
    });

    it('toBuildingCentroidsCollection emits Point features', () => {
        const focus = makePoiFocus();
        const fc = toBuildingCentroidsCollection(focus);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].geometry.type).toBe('Point');
        expect(fc.features[0].id).toBe('way/1');
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
            completed: false,
        });
    });

    it('toPickedPoiCollection sets completed when requested', () => {
        const poi = makePoi();
        const out = toPickedPoiCollection(poi, true);
        expect(out.features[0].properties).toMatchObject({ completed: true });
    });

    it.each<[boolean, boolean]>([
        [false, false],
        [true, false],
        [false, true],
    ])(
        'toPickedPoiCollection projects completed=%s rejected=%s onto the feature',
        (completed, rejected) => {
            const poi = makePoi();
            const props = toPickedPoiCollection(poi, completed, rejected).features[0]
                .properties;
            expect(props).toMatchObject({ completed, rejected });
        },
    );

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

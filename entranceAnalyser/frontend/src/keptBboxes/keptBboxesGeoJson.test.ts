import { describe, expect, it } from 'vitest';

import { makeKeptBbox, makePoi } from '../test/fixtures';
import type { PoiPickEntry } from '../api';
import {
    toCenterCollection,
    toCollectiveBounds,
    toPoiCollection,
    toPolygonCollection,
} from './keptBboxesGeoJson';

describe('toPolygonCollection', () => {
    it('returns an empty collection when no bboxes are provided', () => {
        const fc = toPolygonCollection([]);
        expect(fc).toEqual({ type: 'FeatureCollection', features: [] });
    });

    it('emits one closed-ring Polygon per bbox with id propagated to properties', () => {
        const a = makeKeptBbox({ id: 'a', west: -1, south: -2, east: 3, north: 4 });
        const b = makeKeptBbox({ id: 'b', west: 10, south: 20, east: 11, north: 21 });
        const fc = toPolygonCollection([a, b]);

        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].properties).toEqual({ id: 'a' });
        expect(fc.features[0].geometry.coordinates[0]).toEqual([
            [-1, -2],
            [3, -2],
            [3, 4],
            [-1, 4],
            [-1, -2],
        ]);
        expect(fc.features[1].properties).toEqual({ id: 'b' });
    });
});

describe('toCenterCollection', () => {
    it('returns an empty collection when no bboxes are provided', () => {
        expect(toCenterCollection([])).toEqual({ type: 'FeatureCollection', features: [] });
    });

    it('emits one Point per bbox with coordinates copied from `center`', () => {
        const a = makeKeptBbox({ id: 'a', center: [-73.55, 45.55] });
        const b = makeKeptBbox({ id: 'b', center: [2.35, 48.85] });
        const fc = toCenterCollection([a, b]);

        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-73.55, 45.55] });
        expect(fc.features[0].properties).toEqual({ id: 'a' });
        expect(fc.features[1].geometry).toEqual({ type: 'Point', coordinates: [2.35, 48.85] });
    });
});

describe('toPoiCollection', () => {
    it('returns an empty collection when no picks have resolved to features', () => {
        expect(toPoiCollection({})).toEqual({ type: 'FeatureCollection', features: [] });
        expect(
            toPoiCollection({
                a: { poi: null, completed: false, rejected: false, rejected_reason: null },
            }),
        ).toEqual({
            type: 'FeatureCollection',
            features: [],
        });
    });

    it('emits one Point per non-null pick with bbox/osm metadata in properties', () => {
        const a: PoiPickEntry = {
            poi: makePoi({ osm_type: 'node', osm_id: 1, center: [1, 2], group: 'shops' }),
            completed: false,
            rejected: false,
            rejected_reason: null,
        };
        const b: PoiPickEntry = {
            poi: null,
            completed: false,
            rejected: false,
            rejected_reason: null,
        };
        const c: PoiPickEntry = {
            poi: makePoi({ osm_type: 'way', osm_id: 99, center: [10, 20], group: 'amenities' }),
            completed: true,
            rejected: false,
            rejected_reason: null,
        };
        const fc = toPoiCollection({ a, b, c });

        expect(fc.features).toHaveLength(2);
        expect(fc.features[0]).toMatchObject({
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: {
                bbox_id: 'a',
                osm_type: 'node',
                osm_id: 1,
                group: 'shops',
                completed: false,
            },
        });
        expect(fc.features[1]).toMatchObject({
            geometry: { type: 'Point', coordinates: [10, 20] },
            properties: {
                bbox_id: 'c',
                osm_type: 'way',
                osm_id: 99,
                group: 'amenities',
                completed: true,
            },
        });
    });
});

describe('toCollectiveBounds', () => {
    it('returns null for an empty input so the caller keeps the default view', () => {
        expect(toCollectiveBounds([])).toBeNull();
    });

    it('returns the single-bbox envelope for one row', () => {
        const only = makeKeptBbox({ west: -1, south: -2, east: 3, north: 4 });
        expect(toCollectiveBounds([only])).toEqual([
            [-1, -2],
            [3, 4],
        ]);
    });

    it('computes the envelope across multiple bboxes', () => {
        const bboxes = [
            makeKeptBbox({ id: 'a', west: -10, south: 0, east: -5, north: 5 }),
            makeKeptBbox({ id: 'b', west: 20, south: -30, east: 25, north: -25 }),
            makeKeptBbox({ id: 'c', west: 2, south: 48, east: 3, north: 49 }),
        ];
        expect(toCollectiveBounds(bboxes)).toEqual([
            [-10, -30],
            [25, 49],
        ]);
    });
});

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import { wgs84ToBd09, wgs84ToGcj02 } from './chinaCoords';
import {
    amapUrl,
    baiduPanoramaUrl,
    googleStreetViewUrl,
    kartaViewUrl,
    mapillaryUrl,
    osmEditorMapSegment,
    osmEditorUrl,
    osmEditorUrlForPoi,
    panoramaxUrl,
    type MapPoint,
} from './mapLinks';

const MTL: MapPoint = { lat: 45.5017, lon: -73.5673, zoom: 17.42 };

describe('mapLinks', () => {
    it.each([
        ['mapillary', mapillaryUrl, 'https://www.mapillary.com/app/?lat=45.5017&lng=-73.5673&z=17'],
        [
            'panoramax',
            panoramaxUrl,
            // Panoramax reads its state from the *query string* and emits
            // unencoded slashes in `map=zoom/lat/lon`; we match that exactly.
            'https://panoramax.openstreetmap.fr/?focus=map&map=17/45.5017/-73.5673',
        ],
        ['kartaview', kartaViewUrl, 'https://kartaview.org/map/@45.5017,-73.5673,17z'],
        [
            'google street view',
            googleStreetViewUrl,
            'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=45.5017,-73.5673',
        ],
    ] as const)('%s builder produces the expected deeplink', (_label, build, expected) => {
        expect(build(MTL)).toBe(expected);
    });

    it.each([
        [17.42, 17],
        [12.0, 12],
        [0.95, 0],
        [3.99, 3],
    ])('floors fractional zoom %s to %s in URL builders that take it', (zoom, floored) => {
        expect(mapillaryUrl({ ...MTL, zoom })).toContain(`z=${floored}`);
        expect(panoramaxUrl({ ...MTL, zoom })).toContain(`map=${floored}/`);
        expect(kartaViewUrl({ ...MTL, zoom })).toContain(`,${floored}z`);
    });

    it('preserves full coordinate precision', () => {
        const high: MapPoint = { lat: 48.810323, lon: 2.344034, zoom: 18 };
        expect(mapillaryUrl(high)).toContain('lat=48.810323');
        expect(mapillaryUrl(high)).toContain('lng=2.344034');
    });

    describe('osmEditorMapSegment', () => {
        it('formats zoom/lat/lon for paste into editor permalinks', () => {
            expect(osmEditorMapSegment(MTL)).toBe('20/45.5017/-73.5673');
        });

        it('preserves full coordinate precision', () => {
            expect(osmEditorMapSegment({ lat: 48.810323, lon: 2.344034 })).toBe(
                '20/48.810323/2.344034',
            );
        });
    });

    describe('osmEditorUrl', () => {
        it.each([
            [
                'iD (default osm.org)',
                'https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}',
                'https://www.openstreetmap.org/edit#map=20/45.5017/-73.5673',
            ],
            [
                'iD with editor=id query',
                'https://www.openstreetmap.org/edit?editor=id#map={zoom}/{lat}/{lon}',
                'https://www.openstreetmap.org/edit?editor=id#map=20/45.5017/-73.5673',
            ],
            [
                'self-hosted iD with query string',
                'https://id.example.org/?lat={lat}&lon={lon}&z={zoom}',
                'https://id.example.org/?lat=45.5017&lon=-73.5673&z=20',
            ],
            [
                'JOSM remote control (only lat/lon, no zoom placeholder)',
                'http://127.0.0.1:8111/load_and_zoom?left={lon}&right={lon}&top={lat}&bottom={lat}',
                'http://127.0.0.1:8111/load_and_zoom?left=-73.5673&right=-73.5673&top=45.5017&bottom=45.5017',
            ],
        ] as const)('substitutes %s template correctly', (_label, template, expected) => {
            expect(osmEditorUrl(template, MTL)).toBe(expected);
        });

        it('leaves unrelated braces in the template alone', () => {
            const template = 'https://example.org/{lat},{lon}/{zoom}#{not_a_placeholder}';
            expect(osmEditorUrl(template, MTL)).toBe(
                'https://example.org/45.5017,-73.5673/20#{not_a_placeholder}',
            );
        });
    });

    describe('osmEditorUrlForPoi', () => {
        it('appends the OSM feature id to a hash-based editor URL', () => {
            const url = osmEditorUrlForPoi(
                'https://example.org/id/#map={zoom}/{lat}/{lon}',
                { osm_type: 'way', osm_id: 25540794, center: [-73.4711246, 45.4717765] },
            );
            expect(url).toBe(
                'https://example.org/id/#map=20/45.4717765/-73.4711246&id=w25540794',
            );
        });

        it('skips the id for synthetic sampling centroids', () => {
            const url = osmEditorUrlForPoi(
                'https://example.org/id/#map={zoom}/{lat}/{lon}',
                { osm_type: 'node', osm_id: 0, center: [-73.5, 45.5] },
            );
            expect(url).toBe('https://example.org/id/#map=20/45.5/-73.5');
        });
    });

    describe('Chinese services (datum conversion)', () => {
        // Tian'anmen Square, WGS84.
        const TIANANMEN: MapPoint = { lat: 39.9093, lon: 116.3974, zoom: 17 };

        it('baiduPanoramaUrl converts WGS84 → BD09 in the location parameter', () => {
            const [bdLat, bdLon] = wgs84ToBd09(TIANANMEN.lat, TIANANMEN.lon);
            const url = baiduPanoramaUrl(TIANANMEN);
            const params = new URL(url).searchParams;
            expect(url.startsWith('https://api.map.baidu.com/marker?')).toBe(true);
            expect(params.get('location')).toBe(`${bdLat},${bdLon}`);
            expect(params.get('coord_type')).toBe('bd09ll');
            expect(params.get('output')).toBe('html');
        });

        it('amapUrl converts WGS84 → GCJ-02 in the position parameter', () => {
            const [gcjLat, gcjLon] = wgs84ToGcj02(TIANANMEN.lat, TIANANMEN.lon);
            const url = amapUrl(TIANANMEN);
            const params = new URL(url).searchParams;
            expect(url.startsWith('https://uri.amap.com/marker?')).toBe(true);
            // AMap uses lng,lat order — sanity-check the swap.
            expect(params.get('position')).toBe(`${gcjLon},${gcjLat}`);
            expect(params.get('coordinate')).toBe('gaode');
            expect(params.get('callnative')).toBe('0');
        });

        it.each([
            ['Montreal', 45.5017, -73.5673],
            ['Paris', 48.8566, 2.3522],
        ] as const)(
            'falls back to the WGS84 input verbatim outside China (%s)',
            (_label, lat, lon) => {
                // Out-of-China inputs hit `wgs84ToGcj02`'s pass-through, so
                // AMap's position parameter should match the input lon,lat
                // exactly. Baidu still applies the GCJ-02 → BD09 step
                // globally, so we only assert the location is non-empty
                // and present.
                const point: MapPoint = { lat, lon, zoom: 14 };
                const amap = new URL(amapUrl(point)).searchParams.get('position');
                expect(amap).toBe(`${lon},${lat}`);
                expect(new URL(baiduPanoramaUrl(point)).searchParams.get('location')).toBeTruthy();
            },
        );
    });
});

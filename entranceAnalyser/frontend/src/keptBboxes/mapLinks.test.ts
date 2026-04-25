import { describe, expect, it } from 'vitest';

import {
    googleStreetViewUrl,
    kartaViewUrl,
    mapillaryUrl,
    osmEditorUrl,
    panoramaxUrl,
    type MapPoint,
} from './mapLinks';

const MTL: MapPoint = { lat: 45.5017, lon: -73.5673, zoom: 17.42 };

describe('mapLinks', () => {
    it.each([
        ['mapillary', mapillaryUrl, 'https://www.mapillary.com/app/?lat=45.5017&lng=-73.5673&z=17'],
        ['panoramax', panoramaxUrl, 'https://panoramax.openstreetmap.fr/#map=17/45.5017/-73.5673'],
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
        expect(panoramaxUrl({ ...MTL, zoom })).toContain(`#map=${floored}/`);
        expect(kartaViewUrl({ ...MTL, zoom })).toContain(`,${floored}z`);
    });

    it('preserves full coordinate precision', () => {
        const high: MapPoint = { lat: 48.810323, lon: 2.344034, zoom: 18 };
        expect(mapillaryUrl(high)).toContain('lat=48.810323');
        expect(mapillaryUrl(high)).toContain('lng=2.344034');
    });

    describe('osmEditorUrl', () => {
        it.each([
            [
                'iD (default osm.org)',
                'https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}',
                'https://www.openstreetmap.org/edit#map=17/45.5017/-73.5673',
            ],
            [
                'iD with editor=id query',
                'https://www.openstreetmap.org/edit?editor=id#map={zoom}/{lat}/{lon}',
                'https://www.openstreetmap.org/edit?editor=id#map=17/45.5017/-73.5673',
            ],
            [
                'self-hosted iD with query string',
                'https://id.example.org/?lat={lat}&lon={lon}&z={zoom}',
                'https://id.example.org/?lat=45.5017&lon=-73.5673&z=17',
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
                'https://example.org/45.5017,-73.5673/17#{not_a_placeholder}',
            );
        });
    });
});

import { describe, it, expect, vi } from 'vitest';

import {
    fetchAppConfig,
    fetchKept,
    fetchPoiFocuses,
    fetchPoiPicks,
    fetchRandomBbox,
    pickPoi,
    pickPoiFocus,
    submitDecision,
    type AppConfig,
    type KeptBbox,
    type Poi,
    type PoiFocusResult,
} from './api';
import { makeBbox } from './test/fixtures';

const SAMPLE_POI: Poi = {
    osm_type: 'node',
    osm_id: 42,
    center: [-73.5, 45.5],
    tags: { shop: 'bakery', name: 'Pain' },
    group: 'shops',
};

const SAMPLE_BBOX = makeBbox({ id: '00000000-0000-0000-0000-000000000001' });

/** Build a stub `fetch` that returns a single JSON response. */
function jsonFetch(body: unknown, init: { status?: number; statusText?: string } = {}) {
    return vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
            status: init.status ?? 200,
            statusText: init.statusText ?? 'OK',
            headers: { 'Content-Type': 'application/json' },
        }),
    );
}

describe('api client', () => {
    it('fetchRandomBbox defaults to blended α=0.5 and returns the parsed body', async () => {
        const fetchFn = jsonFetch(SAMPLE_BBOX);
        const bbox = await fetchRandomBbox(undefined, fetchFn);
        expect(fetchFn).toHaveBeenCalledWith('/api/bbox/random?strategy=blended&alpha=0.5');
        expect(bbox).toEqual(SAMPLE_BBOX);
    });

    it.each([
        ['uniform', '/api/bbox/random?strategy=uniform'],
        ['population', '/api/bbox/random?strategy=population'],
        ['built', '/api/bbox/random?strategy=built'],
    ] as const)(
        'fetchRandomBbox omits alpha for %s',
        async (name, expectedUrl) => {
            const fetchFn = jsonFetch(SAMPLE_BBOX);
            await fetchRandomBbox({ name, alpha: 0.5 }, fetchFn);
            expect(fetchFn).toHaveBeenCalledWith(expectedUrl);
        },
    );

    it('fetchRandomBbox forwards a custom blended alpha', async () => {
        const fetchFn = jsonFetch(SAMPLE_BBOX);
        await fetchRandomBbox({ name: 'blended', alpha: 0.25 }, fetchFn);
        expect(fetchFn).toHaveBeenCalledWith('/api/bbox/random?strategy=blended&alpha=0.25');
    });

    it.each(['keep', 'reject'] as const)('submitDecision posts %s as JSON and parses the reply', async (decision) => {
        const fetchFn = jsonFetch({ ok: true, total_kept: 7 });
        const reply = await submitDecision(SAMPLE_BBOX, decision, fetchFn);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe('/api/bbox/decision');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ bbox: SAMPLE_BBOX, decision });

        expect(reply).toEqual({ ok: true, total_kept: 7 });
    });

    it('fetchKept unwraps the { kept } envelope', async () => {
        const kept: KeptBbox[] = [{ ...SAMPLE_BBOX, kept_at: '2026-04-22T00:00:00Z' }];
        const fetchFn = jsonFetch({ kept });
        expect(await fetchKept(fetchFn)).toEqual(kept);
    });

    it('throws a descriptive error on non-OK responses', async () => {
        const fetchFn = jsonFetch({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });
        await expect(fetchRandomBbox(undefined, fetchFn)).rejects.toThrow(/500 Internal Server Error/);
    });

    it('pickPoi POSTs to /poi_pick with the bbox id in the URL', async () => {
        const fetchFn = jsonFetch({ bbox_id: SAMPLE_BBOX.id, poi: SAMPLE_POI });
        const reply = await pickPoi(SAMPLE_BBOX.id, fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe(`/api/bbox/kept/${SAMPLE_BBOX.id}/poi_pick`);
        expect(init.method).toBe('POST');
        expect(reply).toEqual({ bbox_id: SAMPLE_BBOX.id, poi: SAMPLE_POI });
    });

    it.each([
        ['matched POI', SAMPLE_POI],
        ['no match cached', null],
    ] as const)(
        'pickPoi returns a %s payload verbatim',
        async (_label, poi) => {
            const fetchFn = jsonFetch({ bbox_id: SAMPLE_BBOX.id, poi });
            const reply = await pickPoi(SAMPLE_BBOX.id, fetchFn);
            expect(reply.poi).toEqual(poi);
        },
    );

    it('fetchPoiPicks unwraps the { picks } envelope', async () => {
        const picks = [
            { bbox_id: SAMPLE_BBOX.id, poi: SAMPLE_POI },
            { bbox_id: '00000000-0000-0000-0000-000000000002', poi: null },
        ];
        const fetchFn = jsonFetch({ picks });
        expect(await fetchPoiPicks(fetchFn)).toEqual(picks);
        expect(fetchFn).toHaveBeenCalledWith('/api/analyses/poi_picks');
    });

    const SAMPLE_FOCUS: PoiFocusResult = {
        center: [-73.5, 45.5],
        radius_m: 150,
        buildings: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'way/1',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[
                            [-73.501, 45.499],
                            [-73.499, 45.499],
                            [-73.499, 45.501],
                            [-73.501, 45.499],
                        ]],
                    },
                    properties: { building: 'yes' },
                },
            ],
        },
        entrances: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    id: 'node/2',
                    geometry: { type: 'Point', coordinates: [-73.5, 45.5] },
                    properties: { entrance: 'main' },
                },
            ],
        },
    };

    it('pickPoiFocus POSTs to /poi_focus with the bbox id in the URL', async () => {
        const fetchFn = jsonFetch({ bbox_id: SAMPLE_BBOX.id, result: SAMPLE_FOCUS });
        const reply = await pickPoiFocus(SAMPLE_BBOX.id, fetchFn);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe(`/api/bbox/kept/${SAMPLE_BBOX.id}/poi_focus`);
        expect(init.method).toBe('POST');
        expect(reply).toEqual({ bbox_id: SAMPLE_BBOX.id, result: SAMPLE_FOCUS });
    });

    it.each([
        ['409 Conflict (no prior pick)', 409, 'Conflict'],
        ['422 Unprocessable (empty pick)', 422, 'Unprocessable Entity'],
        ['502 Bad Gateway (overpass)', 502, 'Bad Gateway'],
    ] as const)('pickPoiFocus surfaces %s as a thrown Error', async (_label, status, statusText) => {
        const fetchFn = jsonFetch({ message: 'nope' }, { status, statusText });
        await expect(pickPoiFocus(SAMPLE_BBOX.id, fetchFn)).rejects.toThrow(
            new RegExp(`${status} ${statusText}`),
        );
    });

    it('fetchPoiFocuses unwraps the { focuses } envelope', async () => {
        const focuses = [{ bbox_id: SAMPLE_BBOX.id, result: SAMPLE_FOCUS }];
        const fetchFn = jsonFetch({ focuses });
        expect(await fetchPoiFocuses(fetchFn)).toEqual(focuses);
        expect(fetchFn).toHaveBeenCalledWith('/api/analyses/poi_focuses');
    });

    it('fetchAppConfig hits /api/config and returns the parsed body', async () => {
        const config: AppConfig = {
            osm_editor_url: 'https://example.org/edit?lat={lat}&lon={lon}&z={zoom}',
            poi_focus_radius_m: 250,
        };
        const fetchFn = jsonFetch(config);
        expect(await fetchAppConfig(fetchFn)).toEqual(config);
        expect(fetchFn).toHaveBeenCalledWith('/api/config');
    });
});

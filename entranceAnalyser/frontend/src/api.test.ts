import { describe, it, expect, vi } from 'vitest';

import {
    fetchKept,
    fetchPoiPicks,
    fetchRandomBbox,
    pickPoi,
    submitDecision,
    type KeptBbox,
    type Poi,
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
});

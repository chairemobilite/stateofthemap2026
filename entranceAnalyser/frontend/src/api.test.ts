import { describe, it, expect, vi } from 'vitest';

import { fetchKept, fetchRandomBbox, submitDecision, type Bbox, type KeptBbox } from './api';

const SAMPLE_BBOX: Bbox = {
    id: '00000000-0000-0000-0000-000000000001',
    west: -73.6,
    south: 45.5,
    east: -73.5,
    north: 45.6,
    center: [-73.55, 45.55],
    population: null,
    filtered: false,
};

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
    it('fetchRandomBbox hits /api/bbox/random and returns the parsed body', async () => {
        const fetchFn = jsonFetch(SAMPLE_BBOX);
        const bbox = await fetchRandomBbox(fetchFn);
        expect(fetchFn).toHaveBeenCalledWith('/api/bbox/random');
        expect(bbox).toEqual(SAMPLE_BBOX);
    });

    it.each(['keep', 'reject'] as const)('submitDecision posts %s as JSON and parses the reply', async (decision) => {
        const fetchFn = jsonFetch({ ok: true, total_kept: 7 });
        const reply = await submitDecision(SAMPLE_BBOX.id, decision, fetchFn);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe('/api/bbox/decision');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ id: SAMPLE_BBOX.id, decision });

        expect(reply).toEqual({ ok: true, total_kept: 7 });
    });

    it('fetchKept unwraps the { kept } envelope', async () => {
        const kept: KeptBbox[] = [{ ...SAMPLE_BBOX, kept_at: '2026-04-22T00:00:00Z' }];
        const fetchFn = jsonFetch({ kept });
        expect(await fetchKept(fetchFn)).toEqual(kept);
    });

    it('throws a descriptive error on non-OK responses', async () => {
        const fetchFn = jsonFetch({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });
        await expect(fetchRandomBbox(fetchFn)).rejects.toThrow(/500 Internal Server Error/);
    });
});

import { describe, it, expect, vi } from 'vitest';

import { fetchKept, fetchRandomBbox, submitDecision, type KeptBbox } from './api';
import { makeBbox } from './test/fixtures';

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
});

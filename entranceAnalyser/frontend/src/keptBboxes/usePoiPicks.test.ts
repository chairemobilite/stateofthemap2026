import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { PoiPickRecord } from '../api';
import { makePoi } from '../test/fixtures';
import { usePoiPicks } from './usePoiPicks';

const ID_A = '00000000-0000-0000-0000-00000000000a';
const ID_B = '00000000-0000-0000-0000-00000000000b';

describe('usePoiPicks', () => {
    it('starts loading and exposes an empty pick map', () => {
        const fetchAll = vi.fn().mockImplementation(() => new Promise(() => {}));
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));
        expect(result.current.status).toBe('loading');
        expect(result.current.picks).toEqual({});
        expect(result.current.picking.size).toBe(0);
        expect(result.current.savingCompleted.size).toBe(0);
        expect(result.current.error).toBeNull();
    });

    it('hydrates picks from the bulk loader and transitions to idle', async () => {
        const rows: PoiPickRecord[] = [
            { bbox_id: ID_A, poi: makePoi({ osm_id: 1 }), completed: false },
            { bbox_id: ID_B, poi: null, completed: false },
        ];
        const fetchAll = vi.fn().mockResolvedValue(rows);
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));

        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.picks[ID_A]).toEqual({
            poi: rows[0].poi,
            completed: false,
        });
        expect(result.current.picks[ID_B]).toEqual({ poi: null, completed: false });
        expect(fetchAll).toHaveBeenCalledOnce();
    });

    it('surfaces loader errors via status/error fields', async () => {
        const fetchAll = vi.fn().mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.error).toBe('boom');
    });

    it('pick(id) marks the bbox as in-flight, then merges the response', async () => {
        const fetchAll = vi.fn().mockResolvedValue([]);
        let resolve!: (value: PoiPickRecord) => void;
        const pickOne = vi.fn().mockImplementation(
            () =>
                new Promise<PoiPickRecord>((r) => {
                    resolve = r;
                }),
        );

        const { result } = renderHook(() => usePoiPicks({ fetchAll, pickOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        let pickPromise!: Promise<void>;
        act(() => {
            pickPromise = result.current.pick(ID_A);
        });
        await waitFor(() => expect(result.current.picking.has(ID_A)).toBe(true));

        const poi = makePoi({ osm_id: 99, group: 'shops' });
        await act(async () => {
            resolve({ bbox_id: ID_A, poi, completed: false });
            await pickPromise;
        });

        expect(result.current.picking.has(ID_A)).toBe(false);
        expect(result.current.picks[ID_A]).toEqual({ poi, completed: false });
        expect(pickOne).toHaveBeenCalledWith(ID_A);
    });

    it('pick(id) caches a null result when Overpass matched nothing', async () => {
        const fetchAll = vi.fn().mockResolvedValue([]);
        const pickOne = vi.fn().mockResolvedValue({ bbox_id: ID_A, poi: null, completed: false });
        const { result } = renderHook(() => usePoiPicks({ fetchAll, pickOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.pick(ID_A));
        expect(ID_A in result.current.picks).toBe(true);
        expect(result.current.picks[ID_A]).toEqual({ poi: null, completed: false });
    });

    it('pick(id) surfaces backend errors but keeps prior picks intact', async () => {
        const existing = makePoi({ osm_id: 5 });
        const fetchAll = vi.fn().mockResolvedValue([
            { bbox_id: ID_A, poi: existing, completed: false },
        ]);
        const pickOne = vi.fn().mockRejectedValue(new Error('502 Bad Gateway: overpass: ...'));

        const { result } = renderHook(() => usePoiPicks({ fetchAll, pickOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.pick(ID_B));
        expect(result.current.error).toMatch(/502 Bad Gateway/);
        expect(result.current.picking.has(ID_B)).toBe(false);
        expect(result.current.picks[ID_A]).toEqual({ poi: existing, completed: false });
    });

    it('reload() re-fetches and replaces the pick map', async () => {
        const first: PoiPickRecord[] = [{ bbox_id: ID_A, poi: makePoi(), completed: false }];
        const second: PoiPickRecord[] = [
            { bbox_id: ID_A, poi: makePoi({ osm_id: 2 }), completed: true },
            { bbox_id: ID_B, poi: null, completed: false },
        ];
        const fetchAll = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));
        await waitFor(() => expect(result.current.picks[ID_A]?.poi?.osm_id).toBe(1234));

        await act(() => result.current.reload());
        expect(result.current.picks[ID_A]?.poi?.osm_id).toBe(2);
        expect(result.current.picks[ID_A]?.completed).toBe(true);
        expect(ID_B in result.current.picks).toBe(true);
        expect(fetchAll).toHaveBeenCalledTimes(2);
    });

    it('removePickForBbox drops one entry from local state', async () => {
        const poi = makePoi();
        const fetchAll = vi.fn().mockResolvedValue([
            { bbox_id: ID_A, poi, completed: false },
            { bbox_id: ID_B, poi: null, completed: false },
        ]);
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('idle'));
        act(() => result.current.removePickForBbox(ID_A));
        expect(result.current.picks[ID_A]).toBeUndefined();
        expect(result.current.picks[ID_B]).toEqual({ poi: null, completed: false });
    });

    it('setPickCompleted patches and merges completed flag', async () => {
        const poi = makePoi();
        const fetchAll = vi.fn().mockResolvedValue([
            { bbox_id: ID_A, poi, completed: false },
        ]);
        const patchCompleted = vi.fn().mockResolvedValue({
            bbox_id: ID_A,
            poi,
            completed: true,
        });
        const { result } = renderHook(() => usePoiPicks({ fetchAll, patchCompleted }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.setPickCompleted(ID_A, true));
        expect(patchCompleted).toHaveBeenCalledExactlyOnceWith(ID_A, true);
        expect(result.current.picks[ID_A]).toEqual({ poi, completed: true });
        expect(result.current.savingCompleted.size).toBe(0);
    });
});

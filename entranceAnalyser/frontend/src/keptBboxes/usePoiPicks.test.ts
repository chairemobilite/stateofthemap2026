import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { PoiPickRecord, PoiRejectionReason } from '../api';
import { makePoi } from '../test/fixtures';
import { usePoiPicks } from './usePoiPicks';

const ID_A = '00000000-0000-0000-0000-00000000000a';
const ID_B = '00000000-0000-0000-0000-00000000000b';

/// Test fixture: build a `PoiPickRecord` defaulted to "pending" so each
/// case only spells out the field it actually exercises. Mirrors the
/// server's invariant that `completed` and `rejected` cannot both be
/// true at once.
function makeRecord(overrides: Partial<PoiPickRecord> = {}): PoiPickRecord {
    return {
        bbox_id: ID_A,
        poi: makePoi(),
        completed: false,
        rejected: false,
        rejected_reason: null,
        ...overrides,
    };
}

const PENDING_ENTRY = (overrides: Partial<PoiPickRecord> = {}) => {
    const r = makeRecord(overrides);
    return {
        poi: r.poi,
        completed: r.completed,
        rejected: r.rejected,
        rejected_reason: r.rejected_reason,
    };
};

describe('usePoiPicks', () => {
    it('starts loading and exposes an empty pick map', () => {
        const fetchAll = vi.fn().mockImplementation(() => new Promise(() => {}));
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));
        expect(result.current.status).toBe('loading');
        expect(result.current.picks).toEqual({});
        expect(result.current.picking.size).toBe(0);
        expect(result.current.savingDecision.size).toBe(0);
        expect(result.current.error).toBeNull();
    });

    it('hydrates picks from the bulk loader and transitions to idle', async () => {
        const rows: PoiPickRecord[] = [
            makeRecord({ bbox_id: ID_A, poi: makePoi({ osm_id: 1 }) }),
            makeRecord({ bbox_id: ID_B, poi: null }),
        ];
        const fetchAll = vi.fn().mockResolvedValue(rows);
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));

        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.picks[ID_A]).toEqual(PENDING_ENTRY({ poi: rows[0].poi }));
        expect(result.current.picks[ID_B]).toEqual(PENDING_ENTRY({ poi: null }));
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
            resolve(makeRecord({ bbox_id: ID_A, poi }));
            await pickPromise;
        });

        expect(result.current.picking.has(ID_A)).toBe(false);
        expect(result.current.picks[ID_A]).toEqual(PENDING_ENTRY({ poi }));
        expect(pickOne).toHaveBeenCalledWith(ID_A);
    });

    it('pick(id) caches a null result when Overpass matched nothing', async () => {
        const fetchAll = vi.fn().mockResolvedValue([]);
        const pickOne = vi.fn().mockResolvedValue(makeRecord({ bbox_id: ID_A, poi: null }));
        const { result } = renderHook(() => usePoiPicks({ fetchAll, pickOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.pick(ID_A));
        expect(ID_A in result.current.picks).toBe(true);
        expect(result.current.picks[ID_A]).toEqual(PENDING_ENTRY({ poi: null }));
    });

    it('pick(id) surfaces backend errors but keeps prior picks intact', async () => {
        const existing = makePoi({ osm_id: 5 });
        const fetchAll = vi.fn().mockResolvedValue([
            makeRecord({ bbox_id: ID_A, poi: existing }),
        ]);
        const pickOne = vi.fn().mockRejectedValue(new Error('502 Bad Gateway: overpass: ...'));

        const { result } = renderHook(() => usePoiPicks({ fetchAll, pickOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.pick(ID_B));
        expect(result.current.error).toMatch(/502 Bad Gateway/);
        expect(result.current.picking.has(ID_B)).toBe(false);
        expect(result.current.picks[ID_A]).toEqual(PENDING_ENTRY({ poi: existing }));
    });

    it('reload() re-fetches and replaces the pick map', async () => {
        const first: PoiPickRecord[] = [makeRecord({ bbox_id: ID_A, poi: makePoi() })];
        const second: PoiPickRecord[] = [
            makeRecord({ bbox_id: ID_A, poi: makePoi({ osm_id: 2 }), completed: true }),
            makeRecord({ bbox_id: ID_B, poi: null }),
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
            makeRecord({ bbox_id: ID_A, poi }),
            makeRecord({ bbox_id: ID_B, poi: null }),
        ]);
        const { result } = renderHook(() => usePoiPicks({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('idle'));
        act(() => result.current.removePickForBbox(ID_A));
        expect(result.current.picks[ID_A]).toBeUndefined();
        expect(result.current.picks[ID_B]).toEqual(PENDING_ENTRY({ poi: null }));
    });

    it('setPickCompleted patches and merges the completed flag', async () => {
        const poi = makePoi();
        const fetchAll = vi.fn().mockResolvedValue([makeRecord({ bbox_id: ID_A, poi })]);
        const patchDecision = vi.fn().mockResolvedValue(
            makeRecord({ bbox_id: ID_A, poi, completed: true }),
        );
        const { result } = renderHook(() => usePoiPicks({ fetchAll, patchDecision }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.setPickCompleted(ID_A, true));
        expect(patchDecision).toHaveBeenCalledExactlyOnceWith(ID_A, {
            kind: 'completed',
            value: true,
        });
        expect(result.current.picks[ID_A]).toEqual(
            PENDING_ENTRY({ poi, completed: true }),
        );
        expect(result.current.savingDecision.size).toBe(0);
    });

    it.each<PoiRejectionReason>(['no_imagery', 'obsolete', 'other'])(
        'setPickRejected(%s) sends the reason and merges the row',
        async (reason) => {
            const poi = makePoi();
            const fetchAll = vi.fn().mockResolvedValue([makeRecord({ bbox_id: ID_A, poi })]);
            const patchDecision = vi.fn().mockResolvedValue(
                makeRecord({
                    bbox_id: ID_A,
                    poi,
                    rejected: true,
                    rejected_reason: reason,
                }),
            );
            const { result } = renderHook(() =>
                usePoiPicks({ fetchAll, patchDecision }),
            );
            await waitFor(() => expect(result.current.status).toBe('idle'));

            await act(() => result.current.setPickRejected(ID_A, reason));
            expect(patchDecision).toHaveBeenCalledExactlyOnceWith(ID_A, {
                kind: 'rejected',
                reason,
            });
            expect(result.current.picks[ID_A]).toEqual(
                PENDING_ENTRY({ poi, rejected: true, rejected_reason: reason }),
            );
            expect(result.current.savingDecision.size).toBe(0);
        },
    );

    it('setPickUnrejected sends an unreject decision', async () => {
        const poi = makePoi();
        const fetchAll = vi.fn().mockResolvedValue([
            makeRecord({ bbox_id: ID_A, poi, rejected: true, rejected_reason: 'no_imagery' }),
        ]);
        const patchDecision = vi.fn().mockResolvedValue(makeRecord({ bbox_id: ID_A, poi }));
        const { result } = renderHook(() => usePoiPicks({ fetchAll, patchDecision }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.setPickUnrejected(ID_A));
        expect(patchDecision).toHaveBeenCalledExactlyOnceWith(ID_A, { kind: 'unreject' });
        expect(result.current.picks[ID_A]).toEqual(PENDING_ENTRY({ poi }));
    });

    it('decision PATCH errors surface via error and clear savingDecision', async () => {
        const poi = makePoi();
        const fetchAll = vi.fn().mockResolvedValue([makeRecord({ bbox_id: ID_A, poi })]);
        const patchDecision = vi.fn().mockRejectedValue(new Error('422 Unprocessable Entity'));
        const { result } = renderHook(() => usePoiPicks({ fetchAll, patchDecision }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.setPickRejected(ID_A, 'no_imagery'));
        expect(result.current.error).toMatch(/422 Unprocessable Entity/);
        expect(result.current.savingDecision.size).toBe(0);
        // Local state must remain untouched after a failed PATCH.
        expect(result.current.picks[ID_A]).toEqual(PENDING_ENTRY({ poi }));
    });
});

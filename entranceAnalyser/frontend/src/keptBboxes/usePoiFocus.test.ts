import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { PoiFocusRecord } from '../api';
import { makePoiFocus } from '../test/fixtures';
import { usePoiFocus } from './usePoiFocus';

const ID_A = '00000000-0000-0000-0000-00000000000a';
const ID_B = '00000000-0000-0000-0000-00000000000b';

describe('usePoiFocus', () => {
    it('starts loading and exposes an empty focus map', () => {
        const fetchAll = vi.fn().mockImplementation(() => new Promise(() => {}));
        const { result } = renderHook(() => usePoiFocus({ fetchAll }));
        expect(result.current.status).toBe('loading');
        expect(result.current.focuses).toEqual({});
        expect(result.current.loading.size).toBe(0);
        expect(result.current.error).toBeNull();
    });

    it('hydrates focuses from the bulk loader and transitions to idle', async () => {
        const focus = makePoiFocus({ radius_m: 200 });
        const rows: PoiFocusRecord[] = [{ bbox_id: ID_A, result: focus }];
        const fetchAll = vi.fn().mockResolvedValue(rows);
        const { result } = renderHook(() => usePoiFocus({ fetchAll }));

        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.focuses[ID_A]).toEqual(focus);
        expect(fetchAll).toHaveBeenCalledOnce();
    });

    it('surfaces loader errors via status/error fields', async () => {
        const fetchAll = vi.fn().mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => usePoiFocus({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.error).toBe('boom');
    });

    it.each([
        // (radiusArg, focusRadius) — radiusArg is what we pass to loadFocus,
        // focusRadius is what the (mocked) backend returns. They differ on
        // purpose so the test catches a regression where the radius arg is
        // dropped instead of passed through.
        [undefined, 250],
        [400, 400],
    ] as const)(
        'loadFocus(id, %s) marks in-flight, threads radius to loadOne, and merges the response',
        async (radiusArg, focusRadius) => {
            const fetchAll = vi.fn().mockResolvedValue([]);
            let resolve!: (value: PoiFocusRecord) => void;
            const loadOne = vi.fn().mockImplementation(
                () =>
                    new Promise<PoiFocusRecord>((r) => {
                        resolve = r;
                    }),
            );

            const { result } = renderHook(() => usePoiFocus({ fetchAll, loadOne }));
            await waitFor(() => expect(result.current.status).toBe('idle'));

            let loadPromise!: Promise<void>;
            act(() => {
                loadPromise = result.current.loadFocus(ID_A, radiusArg);
            });
            await waitFor(() => expect(result.current.loading.has(ID_A)).toBe(true));

            const focus = makePoiFocus({ radius_m: focusRadius });
            await act(async () => {
                resolve({ bbox_id: ID_A, result: focus });
                await loadPromise;
            });

            expect(result.current.loading.has(ID_A)).toBe(false);
            expect(result.current.focuses[ID_A]).toEqual(focus);
            expect(loadOne).toHaveBeenCalledWith(ID_A, radiusArg, undefined);
        },
    );

    it('loadFocus forwards refresh to loadOne', async () => {
        const fetchAll = vi.fn().mockResolvedValue([]);
        const loadOne = vi.fn().mockResolvedValue({
            bbox_id: ID_A,
            result: makePoiFocus({ radius_m: 200 }),
        });
        const { result } = renderHook(() => usePoiFocus({ fetchAll, loadOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.loadFocus(ID_A, 200, { refresh: true }));
        expect(loadOne).toHaveBeenCalledWith(ID_A, 200, { refresh: true });
    });

    it.each([
        ['409 Conflict (no pick)', '409 Conflict: no POI pick yet'],
        ['422 Unprocessable (empty pick)', '422 Unprocessable Entity: empty pick'],
        ['502 Bad Gateway (overpass)', '502 Bad Gateway: overpass: ...'],
    ] as const)('loadFocus(id) surfaces %s without wiping prior focuses', async (_label, message) => {
        const existing = makePoiFocus();
        const fetchAll = vi.fn().mockResolvedValue([{ bbox_id: ID_A, result: existing }]);
        const loadOne = vi.fn().mockRejectedValue(new Error(message));

        const { result } = renderHook(() => usePoiFocus({ fetchAll, loadOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.loadFocus(ID_B));
        expect(result.current.error).toBe(message);
        expect(result.current.loading.has(ID_B)).toBe(false);
        // Previously hydrated focus must survive an unrelated error.
        expect(result.current.focuses[ID_A]).toEqual(existing);
    });

    it('reload() re-fetches and replaces the focus map', async () => {
        const first = makePoiFocus({ radius_m: 100 });
        const second = makePoiFocus({ radius_m: 300 });
        const fetchAll = vi
            .fn()
            .mockResolvedValueOnce([{ bbox_id: ID_A, result: first }])
            .mockResolvedValueOnce([{ bbox_id: ID_A, result: second }]);

        const { result } = renderHook(() => usePoiFocus({ fetchAll }));
        await waitFor(() => expect(result.current.focuses[ID_A]?.radius_m).toBe(100));

        await act(() => result.current.reload());
        expect(result.current.focuses[ID_A]?.radius_m).toBe(300);
        expect(fetchAll).toHaveBeenCalledTimes(2);
    });

    it('dropFocus removes one bbox from the in-memory map', async () => {
        const fetchAll = vi.fn().mockResolvedValue([
            { bbox_id: ID_A, result: makePoiFocus() },
            { bbox_id: ID_B, result: makePoiFocus({ radius_m: 99 }) },
        ]);
        const { result } = renderHook(() => usePoiFocus({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('idle'));
        act(() => result.current.dropFocus(ID_A));
        expect(result.current.focuses[ID_A]).toBeUndefined();
        expect(result.current.focuses[ID_B]).toBeDefined();
    });
});

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { DEFAULT_STRATEGY, type Strategy } from './api';
import { useSampling } from './useSampling';
import { makeBbox } from './test/fixtures';

const fixture = (suffix: string) =>
    makeBbox({ id: `00000000-0000-0000-0000-00000000000${suffix}` });

describe('useSampling', () => {
    it('auto-loads a first candidate on mount', async () => {
        const first = fixture('1');
        const fetchNext = vi.fn().mockResolvedValue(first);

        const { result } = renderHook(() => useSampling({ fetchNext, submit: vi.fn() }));

        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.bbox).toEqual(first);
        expect(fetchNext).toHaveBeenCalledTimes(1);
    });

    it('surfaces backend errors on the initial load', async () => {
        const fetchNext = vi.fn().mockRejectedValue(new Error('backend down'));
        const { result } = renderHook(() => useSampling({ fetchNext, submit: vi.fn() }));

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.error).toBe('backend down');
        expect(result.current.bbox).toBeNull();
    });

    it.each(['keep', 'reject'] as const)('decide(%s) submits, updates kept count, and fetches the next bbox', async (decision) => {
        const first = fixture("1");
        const second = fixture("2");
        const fetchNext = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const submit = vi.fn().mockResolvedValue({ total_kept: decision === 'keep' ? 1 : 0 });

        const { result } = renderHook(() => useSampling({ fetchNext, submit }));
        await waitFor(() => expect(result.current.bbox).toEqual(first));

        await act(() => result.current.decide(decision));

        expect(submit).toHaveBeenCalledExactlyOnceWith(first, decision);
        expect(result.current.bbox).toEqual(second);
        expect(result.current.keptCount).toBe(decision === 'keep' ? 1 : 0);
        expect(result.current.status).toBe('idle');
    });

    it('skip() fetches the next bbox without calling submit', async () => {
        const first = fixture("1");
        const second = fixture("2");
        const fetchNext = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const submit = vi.fn();

        const { result } = renderHook(() => useSampling({ fetchNext, submit }));
        await waitFor(() => expect(result.current.bbox).toEqual(first));

        await act(() => result.current.skip());
        expect(result.current.bbox).toEqual(second);
        expect(submit).not.toHaveBeenCalled();
    });

    it('starts with the default strategy and passes it to fetchNext', async () => {
        const first = fixture('1');
        const fetchNext = vi.fn().mockResolvedValue(first);
        const { result } = renderHook(() => useSampling({ fetchNext, submit: vi.fn() }));

        await waitFor(() => expect(result.current.bbox).toEqual(first));
        expect(result.current.strategy).toEqual(DEFAULT_STRATEGY);
        expect(fetchNext).toHaveBeenCalledExactlyOnceWith(DEFAULT_STRATEGY);
    });

    it('setStrategy stores the new strategy and triggers a fresh fetch', async () => {
        const first = fixture('1');
        const second = fixture('2');
        const fetchNext = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const { result } = renderHook(() => useSampling({ fetchNext, submit: vi.fn() }));
        await waitFor(() => expect(result.current.bbox).toEqual(first));

        const uniform: Strategy = { name: 'uniform', alpha: DEFAULT_STRATEGY.alpha };
        await act(async () => {
            result.current.setStrategy(uniform);
        });
        await waitFor(() => expect(result.current.bbox).toEqual(second));
        expect(result.current.strategy).toEqual(uniform);
        expect(fetchNext).toHaveBeenNthCalledWith(2, uniform);
    });

    it('respects initialStrategy on first load', async () => {
        const first = fixture('1');
        const fetchNext = vi.fn().mockResolvedValue(first);
        const initial: Strategy = { name: 'population', alpha: 0 };
        renderHook(() => useSampling({ fetchNext, submit: vi.fn(), initialStrategy: initial }));
        await waitFor(() => expect(fetchNext).toHaveBeenCalled());
        expect(fetchNext).toHaveBeenCalledWith(initial);
    });

    it('applyCustomCentroid loads a bbox via fetchCustomCentroid and returns true on success', async () => {
        const first = fixture('1');
        const custom = fixture('2');
        const fetchNext = vi.fn().mockResolvedValue(first);
        const fetchCustomCentroid = vi.fn().mockResolvedValue(custom);
        const { result } = renderHook(() =>
            useSampling({ fetchNext, submit: vi.fn(), fetchCustomCentroid }),
        );
        await waitFor(() => expect(result.current.bbox).toEqual(first));

        let ok = false;
        await act(async () => {
            ok = await result.current.applyCustomCentroid(45.5, -73.5);
        });
        expect(ok).toBe(true);
        expect(fetchCustomCentroid).toHaveBeenCalledExactlyOnceWith(45.5, -73.5);
        expect(result.current.bbox).toEqual(custom);
        expect(result.current.status).toBe('idle');
    });

    it('applyCustomCentroid returns false and sets error when fetch fails', async () => {
        const first = fixture('1');
        const fetchNext = vi.fn().mockResolvedValue(first);
        const fetchCustomCentroid = vi.fn().mockRejectedValue(new Error('outside grid'));
        const { result } = renderHook(() =>
            useSampling({ fetchNext, submit: vi.fn(), fetchCustomCentroid }),
        );
        await waitFor(() => expect(result.current.bbox).toEqual(first));

        let ok = true;
        await act(async () => {
            ok = await result.current.applyCustomCentroid(0, 0);
        });
        expect(ok).toBe(false);
        expect(result.current.error).toBe('outside grid');
        expect(result.current.status).toBe('error');
    });

    it('applyCustomOsm loads a bbox via fetchCustomOsm', async () => {
        const first = fixture('1');
        const custom = fixture('2');
        const fetchNext = vi.fn().mockResolvedValue(first);
        const fetchCustomOsm = vi.fn().mockResolvedValue(custom);
        const { result } = renderHook(() =>
            useSampling({ fetchNext, submit: vi.fn(), fetchCustomOsm }),
        );
        await waitFor(() => expect(result.current.bbox).toEqual(first));

        let ok = false;
        await act(async () => {
            ok = await result.current.applyCustomOsm('node/1');
        });
        expect(ok).toBe(true);
        expect(fetchCustomOsm).toHaveBeenCalledExactlyOnceWith('node/1');
        expect(result.current.bbox).toEqual(custom);
    });
});

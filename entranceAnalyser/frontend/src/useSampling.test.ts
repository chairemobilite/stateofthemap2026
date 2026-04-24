import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

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
});

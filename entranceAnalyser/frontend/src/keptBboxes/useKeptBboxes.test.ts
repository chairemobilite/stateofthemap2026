/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { makeKeptBbox } from '../test/fixtures';
import { useKeptBboxes } from './useKeptBboxes';

describe('useKeptBboxes', () => {
    it('starts in the loading state before the first fetch resolves', () => {
        const fetchAll = vi.fn().mockImplementation(() => new Promise(() => {}));
        const { result } = renderHook(() => useKeptBboxes({ fetchAll }));
        expect(result.current.status).toBe('loading');
        expect(result.current.keptBboxes).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it('auto-loads the kept list on mount and transitions to idle', async () => {
        const rows = [makeKeptBbox({ id: 'a' }), makeKeptBbox({ id: 'b' })];
        const fetchAll = vi.fn().mockResolvedValue(rows);

        const { result } = renderHook(() => useKeptBboxes({ fetchAll }));

        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.keptBboxes).toEqual(rows);
        expect(fetchAll).toHaveBeenCalledOnce();
    });

    it('returns an empty array + idle status when the backend has no kept rows', async () => {
        const fetchAll = vi.fn().mockResolvedValue([]);
        const { result } = renderHook(() => useKeptBboxes({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('idle'));
        expect(result.current.keptBboxes).toEqual([]);
    });

    it('surfaces backend errors via status/error fields', async () => {
        const fetchAll = vi.fn().mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => useKeptBboxes({ fetchAll }));
        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current.error).toBe('boom');
        expect(result.current.keptBboxes).toEqual([]);
    });

    it('reload() re-fetches and replaces the list', async () => {
        const first = [makeKeptBbox({ id: 'a' })];
        const second = [makeKeptBbox({ id: 'a' }), makeKeptBbox({ id: 'b' })];
        const fetchAll = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

        const { result } = renderHook(() => useKeptBboxes({ fetchAll }));
        await waitFor(() => expect(result.current.keptBboxes).toEqual(first));

        await act(() => result.current.reload());
        expect(result.current.keptBboxes).toEqual(second);
        expect(fetchAll).toHaveBeenCalledTimes(2);
    });

    it('removeKept calls DELETE then filters local state', async () => {
        const a = makeKeptBbox({ id: 'a' });
        const b = makeKeptBbox({ id: 'b' });
        const fetchAll = vi.fn().mockResolvedValue([a, b]);
        const deleteOne = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useKeptBboxes({ fetchAll, deleteOne }));
        await waitFor(() => expect(result.current.status).toBe('idle'));

        await act(() => result.current.removeKept('a'));
        expect(deleteOne).toHaveBeenCalledExactlyOnceWith('a');
        expect(result.current.keptBboxes).toEqual([b]);
    });
});

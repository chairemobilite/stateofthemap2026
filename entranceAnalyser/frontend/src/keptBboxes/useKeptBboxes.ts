/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! `useKeptBboxes` — fetches the full list of kept bboxes from the
//! backend on mount.
//!
//! Mirrors the shape of `useSampling`: owns the fetched rows plus a
//! `loading` / `idle` / `error` status so presentational views can
//! consume flat state. The fetcher is injectable for tests.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { deleteKept, fetchKept, type KeptBbox } from '../api';

/** Fetch lifecycle for the kept-bboxes list; consumed by every component
 *  that renders hook output (the map overlay, the former list view). */
export type KeptBboxesStatus = 'loading' | 'idle' | 'error';

export interface UseKeptBboxesOptions {
    /** Override the API module, mostly for tests. */
    fetchAll?: () => Promise<KeptBbox[]>;
    /** Override DELETE, mostly for tests. */
    deleteOne?: (bboxId: string) => Promise<void>;
}

export interface KeptBboxesState {
    keptBboxes: KeptBbox[];
    status: KeptBboxesStatus;
    error: string | null;
    reload: () => Promise<void>;
    /** Remove one kept bbox on the server and drop it from local state. */
    removeKept: (bboxId: string) => Promise<void>;
}

/**
 * Load every kept bbox on mount and expose the result as flat state.
 *
 * @param options - Optional overrides; `fetchAll` is used by tests to
 *                  substitute the API call.
 */
export function useKeptBboxes(options: UseKeptBboxesOptions = {}): KeptBboxesState {
    const fetchAll = useMemo(
        () => options.fetchAll ?? (() => fetchKept()),
        [options.fetchAll],
    );
    const deleteOne = useMemo(
        () => options.deleteOne ?? ((id: string) => deleteKept(id)),
        [options.deleteOne],
    );

    const [keptBboxes, setKeptBboxes] = useState<KeptBbox[]>([]);
    const [status, setStatus] = useState<KeptBboxesStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    // React 18+ StrictMode double-invokes effects in dev; this ref stops
    // the initial fetch from firing twice, matching `useSampling`.
    const bootstrapped = useRef(false);

    const reload = useCallback(async () => {
        setStatus('loading');
        setError(null);
        try {
            setKeptBboxes(await fetchAll());
            setStatus('idle');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('error');
        }
    }, [fetchAll]);

    const removeKept = useCallback(
        async (bboxId: string) => {
            setError(null);
            try {
                await deleteOne(bboxId);
                setKeptBboxes((rows) => rows.filter((b) => b.id !== bboxId));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                throw err;
            }
        },
        [deleteOne],
    );

    useEffect(() => {
        if (bootstrapped.current) return;
        bootstrapped.current = true;
        void reload();
    }, [reload]);

    return { keptBboxes, status, error, reload, removeKept };
}

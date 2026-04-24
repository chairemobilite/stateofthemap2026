//! `useKeptBboxes` — fetches the full list of kept bboxes from the
//! backend on mount.
//!
//! Mirrors the shape of `useSampling`: owns the fetched rows plus a
//! `loading` / `idle` / `error` status so presentational views can
//! consume flat state. The fetcher is injectable for tests.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchKept, type KeptBbox } from '../api';
import type { KeptBboxesStatus } from './KeptBboxesView';

export interface UseKeptBboxesOptions {
    /** Override the API module, mostly for tests. */
    fetchAll?: () => Promise<KeptBbox[]>;
}

export interface KeptBboxesState {
    keptBboxes: KeptBbox[];
    status: KeptBboxesStatus;
    error: string | null;
    reload: () => Promise<void>;
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

    useEffect(() => {
        if (bootstrapped.current) return;
        bootstrapped.current = true;
        void reload();
    }, [reload]);

    return { keptBboxes, status, error, reload };
}

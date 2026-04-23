//! `useSampling` — glue between the React UI and the backend API.
//!
//! Owns the current candidate bbox, the kept counter, and the loading /
//! error status. Presentational components consume the returned state
//! and invoke `decide` / `skip` on user action.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchRandomBbox, submitDecision, type Bbox, type Decision } from './api';

export type SamplingStatus = 'loading' | 'idle' | 'error';

export interface SamplingState {
    bbox: Bbox | null;
    keptCount: number;
    status: SamplingStatus;
    error: string | null;
    decide: (decision: Decision) => Promise<void>;
    skip: () => Promise<void>;
}

export interface UseSamplingOptions {
    /** Override the API module, mostly for tests. */
    fetchNext?: () => Promise<Bbox>;
    submit?: (id: string, decision: Decision) => Promise<{ total_kept: number }>;
}

/**
 * Drive the Keep / Reject / Skip workflow.
 *
 * Auto-loads an initial candidate on mount. `decide('keep' | 'reject')`
 * persists the current bbox and then pulls the next one; `skip()`
 * discards the current bbox locally and pulls the next one without
 * round-tripping to the backend.
 */
export function useSampling(options: UseSamplingOptions = {}): SamplingState {
    // Memoize the default callbacks so the effects below see stable
    // references when the caller does not override them.
    const fetchNext = useMemo(
        () => options.fetchNext ?? (() => fetchRandomBbox()),
        [options.fetchNext],
    );
    const submit = useMemo(
        () =>
            options.submit ??
            ((id: string, decision: Decision) => submitDecision(id, decision)),
        [options.submit],
    );

    const [bbox, setBbox] = useState<Bbox | null>(null);
    const [keptCount, setKeptCount] = useState(0);
    const [status, setStatus] = useState<SamplingStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    // React 18+ StrictMode double-invokes effects in dev; this ref stops
    // the initial fetch from firing twice.
    const bootstrapped = useRef(false);

    const loadNext = useCallback(async () => {
        setStatus('loading');
        setError(null);
        try {
            setBbox(await fetchNext());
            setStatus('idle');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('error');
        }
    }, [fetchNext]);

    const decide = useCallback(
        async (decision: Decision) => {
            if (!bbox) return;
            setStatus('loading');
            setError(null);
            try {
                const reply = await submit(bbox.id, decision);
                setKeptCount(reply.total_kept);
                await loadNext();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('error');
            }
        },
        [bbox, loadNext, submit],
    );

    useEffect(() => {
        if (bootstrapped.current) return;
        bootstrapped.current = true;
        void loadNext();
    }, [loadNext]);

    return { bbox, keptCount, status, error, decide, skip: loadNext };
}

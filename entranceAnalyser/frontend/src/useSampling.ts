/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! `useSampling` — glue between the React UI and the backend API.
//!
//! Owns the current candidate bbox, the kept counter, and the loading /
//! error status. Presentational components consume the returned state
//! and invoke `decide` / `skip` on user action.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    DEFAULT_STRATEGY,
    fetchBboxAtCustomCentroid,
    fetchBboxAtCustomOsm,
    fetchRandomBbox,
    submitDecision,
    type Bbox,
    type Decision,
    type Strategy,
} from './api';

export type SamplingStatus = 'loading' | 'idle' | 'error';

export interface SamplingState {
    bbox: Bbox | null;
    keptCount: number;
    status: SamplingStatus;
    error: string | null;
    strategy: Strategy;
    setStrategy: (next: Strategy) => void;
    decide: (decision: Decision) => Promise<void>;
    skip: () => Promise<void>;
    /** Load a bbox centred on the given coordinates (nearest cell for stats). */
    applyCustomCentroid: (lat: number, lon: number) => Promise<boolean>;
    /** Load a bbox centred on one OSM object's Overpass centre. */
    applyCustomOsm: (osm_ref: string) => Promise<boolean>;
}

export interface UseSamplingOptions {
    /** Initial strategy; defaults to the module-level `DEFAULT_STRATEGY`. */
    initialStrategy?: Strategy;
    /** Override the API module, mostly for tests. */
    fetchNext?: (strategy: Strategy) => Promise<Bbox>;
    /** Override `POST /api/bbox/custom_centroid` for tests. */
    fetchCustomCentroid?: (lat: number, lon: number) => Promise<Bbox>;
    /** Override `POST /api/bbox/custom_osm` for tests. */
    fetchCustomOsm?: (osm_ref: string) => Promise<Bbox>;
    submit?: (bbox: Bbox, decision: Decision) => Promise<{ total_kept: number }>;
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
        () => options.fetchNext ?? ((s: Strategy) => fetchRandomBbox(s)),
        [options.fetchNext],
    );
    const fetchCustomCentroid = useMemo(
        () => options.fetchCustomCentroid ?? ((lat: number, lon: number) => fetchBboxAtCustomCentroid(lat, lon)),
        [options.fetchCustomCentroid],
    );
    const fetchCustomOsmFn = useMemo(
        () => options.fetchCustomOsm ?? ((osm_ref: string) => fetchBboxAtCustomOsm(osm_ref)),
        [options.fetchCustomOsm],
    );
    const submit = useMemo(
        () =>
            options.submit ??
            ((bbox: Bbox, decision: Decision) => submitDecision(bbox, decision)),
        [options.submit],
    );

    const [bbox, setBbox] = useState<Bbox | null>(null);
    const [keptCount, setKeptCount] = useState(0);
    const [status, setStatus] = useState<SamplingStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    const [strategy, setStrategyState] = useState<Strategy>(
        options.initialStrategy ?? DEFAULT_STRATEGY,
    );
    // React 18+ StrictMode double-invokes effects in dev; this ref stops
    // the initial fetch from firing twice. Tracking the last strategy
    // we fetched with lets us re-fetch exactly once when the user picks
    // a new one.
    const bootstrapped = useRef(false);
    const lastFetchedStrategy = useRef<Strategy | null>(null);

    const loadNext = useCallback(
        async (withStrategy: Strategy = strategy) => {
            setStatus('loading');
            setError(null);
            try {
                setBbox(await fetchNext(withStrategy));
                lastFetchedStrategy.current = withStrategy;
                setStatus('idle');
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('error');
            }
        },
        [fetchNext, strategy],
    );

    const decide = useCallback(
        async (decision: Decision) => {
            if (!bbox) return;
            setStatus('loading');
            setError(null);
            try {
                const reply = await submit(bbox, decision);
                setKeptCount(reply.total_kept);
                await loadNext();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('error');
            }
        },
        [bbox, loadNext, submit],
    );

    const setStrategy = useCallback(
        (next: Strategy) => {
            setStrategyState(next);
            void loadNext(next);
        },
        [loadNext],
    );

    const applyCustomCentroid = useCallback(
        async (lat: number, lon: number) => {
            setStatus('loading');
            setError(null);
            try {
                setBbox(await fetchCustomCentroid(lat, lon));
                setStatus('idle');
                return true;
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('error');
                return false;
            }
        },
        [fetchCustomCentroid],
    );

    const applyCustomOsm = useCallback(
        async (osm_ref: string) => {
            setStatus('loading');
            setError(null);
            try {
                setBbox(await fetchCustomOsmFn(osm_ref));
                setStatus('idle');
                return true;
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setStatus('error');
                return false;
            }
        },
        [fetchCustomOsmFn],
    );

    useEffect(() => {
        if (bootstrapped.current) return;
        bootstrapped.current = true;
        void loadNext(strategy);
    }, [loadNext, strategy]);

    return {
        bbox,
        keptCount,
        status,
        error,
        strategy,
        setStrategy,
        decide,
        skip: () => loadNext(),
        applyCustomCentroid,
        applyCustomOsm,
    };
}

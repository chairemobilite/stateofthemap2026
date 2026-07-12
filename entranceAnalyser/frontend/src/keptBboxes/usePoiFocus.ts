/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! `usePoiFocus` — owns the per-bbox POI focus map.
//!
//! Loads every cached focus result from `/api/analyses/poi_focuses`
//! on mount and exposes a `loadFocus(bboxId)` action that POSTs to
//! the per-bbox `/poi_focus` endpoint and merges the result into
//! local state. Mirrors the shape of `usePoiPicks` (`loading | idle |
//! error` status, in-flight set, injectable fetchers) so the focus
//! view consumes a flat React state tree.
//!
//! Unlike `usePoiPicks`, focus results are never `null`: the backend
//! returns 409 when the prior pick is missing and 422 when the pick
//! was empty, so a present entry always carries a real
//! `PoiFocusResult`. Errors surface through the `error` field.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    fetchPoiFocuses,
    pickPoiFocus,
    type PoiFocusRecord,
    type PoiFocusResult,
} from '../api';

export type PoiFocusStatus = 'loading' | 'idle' | 'error';

export interface UsePoiFocusOptions {
    /** Override for the bulk loader, mostly for tests. */
    fetchAll?: () => Promise<PoiFocusRecord[]>;
    /** Override for the per-bbox load action, mostly for tests.
     *  The optional `radiusM` and `opts.refresh` mirror `pickPoiFocus`. */
    loadOne?: (
        bboxId: string,
        radiusM?: number,
        opts?: { refresh?: boolean },
    ) => Promise<PoiFocusRecord>;
}

export interface PoiFocusState {
    /** `focuses[bboxId]` is `undefined` until a focus has been
     *  fetched, otherwise the cached `PoiFocusResult`. */
    focuses: Record<string, PoiFocusResult>;
    /** Bbox ids whose `loadFocus(...)` is currently in flight. */
    loading: Set<string>;
    status: PoiFocusStatus;
    error: string | null;
    /** Fetch (and cache) the focus result for one bbox. Idempotent
     *  on the server side when `radiusM` matches the cached row and
     *  `opts.refresh` is not set; a different radius or
     *  `{ refresh: true }` re-issues Overpass and overwrites the
     *  cached value. Omitting `radiusM` lets the backend fall back
     *  to its `POI_FOCUS_RADIUS_M` default. */
    loadFocus: (
        bboxId: string,
        radiusM?: number,
        opts?: { refresh?: boolean },
    ) => Promise<void>;
    /** Forget cached focus for a bbox (e.g. after it was removed from kept). */
    dropFocus: (bboxId: string) => void;
    reload: () => Promise<void>;
}

/**
 * Load every cached POI focus on mount and expose a
 * `loadFocus(bboxId)` action that triggers the Overpass-backed
 * focus query and merges the result into local state.
 *
 * @param options - Optional overrides for the loader / per-bbox fetcher.
 */
export function usePoiFocus(options: UsePoiFocusOptions = {}): PoiFocusState {
    const fetchAll = useMemo(
        () => options.fetchAll ?? (() => fetchPoiFocuses()),
        [options.fetchAll],
    );
    const loadOne = useMemo(
        () =>
            options.loadOne ??
            ((bboxId: string, radiusM?: number, opts?: { refresh?: boolean }) =>
                pickPoiFocus(bboxId, radiusM, { refresh: opts?.refresh })),
        [options.loadOne],
    );

    const [focuses, setFocuses] = useState<Record<string, PoiFocusResult>>({});
    const [loading, setLoading] = useState<Set<string>>(() => new Set());
    const [status, setStatus] = useState<PoiFocusStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    // Same StrictMode bootstrap guard as `usePoiPicks`.
    const bootstrapped = useRef(false);

    const reload = useCallback(async () => {
        setStatus('loading');
        setError(null);
        try {
            const rows = await fetchAll();
            const next: Record<string, PoiFocusResult> = {};
            for (const row of rows) next[row.bbox_id] = row.result;
            setFocuses(next);
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

    const dropFocus = useCallback((bboxId: string) => {
        setFocuses((f) => {
            const next = { ...f };
            delete next[bboxId];
            return next;
        });
    }, []);

    const loadFocus = useCallback(
        async (bboxId: string, radiusM?: number, opts?: { refresh?: boolean }) => {
            setError(null);
            setLoading((s) => {
                const next = new Set(s);
                next.add(bboxId);
                return next;
            });
            try {
                const row = await loadOne(bboxId, radiusM, opts);
                setFocuses((f) => ({ ...f, [row.bbox_id]: row.result }));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setLoading((s) => {
                    const next = new Set(s);
                    next.delete(bboxId);
                    return next;
                });
            }
        },
        [loadOne],
    );

    return { focuses, loading, status, error, loadFocus, dropFocus, reload };
}

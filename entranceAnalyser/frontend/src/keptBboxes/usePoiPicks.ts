//! `usePoiPicks` — owns the per-bbox POI pick map.
//!
//! Loads every cached pick from `/api/analyses/poi_picks` on mount,
//! and exposes a `pick(bboxId)` action that POSTs to the per-bbox
//! `/poi_pick` endpoint and merges the result into local state. Mirrors
//! the shape of `useKeptBboxes` (`loading | idle | error` status, plus
//! a `reload`) so the surrounding view consumes flat state.
//!
//! The fetcher and the picker are injectable so unit tests can run
//! without touching the network — same pattern as `useKeptBboxes`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchPoiPicks, pickPoi, type Poi, type PoiPickRecord } from '../api';

/** Same lifecycle as `useKeptBboxes` for visual consistency. */
export type PoiPicksStatus = 'loading' | 'idle' | 'error';

export interface UsePoiPicksOptions {
    /** Override for the bulk loader, mostly for tests. */
    fetchAll?: () => Promise<PoiPickRecord[]>;
    /** Override for the per-bbox pick action, mostly for tests. */
    pickOne?: (bboxId: string) => Promise<PoiPickRecord>;
}

export interface PoiPicksState {
    /** `picks[bboxId]` is `undefined` when no pick has been requested
     *  yet, `null` when Overpass matched nothing, otherwise the POI. */
    picks: Record<string, Poi | null>;
    /** Bbox ids whose `pick(...)` is currently in flight, so the UI
     *  can disable the corresponding button without blocking anything
     *  else on the page. */
    picking: Set<string>;
    status: PoiPicksStatus;
    error: string | null;
    pick: (bboxId: string) => Promise<void>;
    reload: () => Promise<void>;
}

/**
 * Load every cached POI pick on mount and expose a `pick(bboxId)`
 * action that runs the Overpass-backed picker and merges the result
 * into local state.
 *
 * @param options - Optional overrides for the loader / picker.
 */
export function usePoiPicks(options: UsePoiPicksOptions = {}): PoiPicksState {
    const fetchAll = useMemo(
        () => options.fetchAll ?? (() => fetchPoiPicks()),
        [options.fetchAll],
    );
    const pickOne = useMemo(
        () => options.pickOne ?? ((bboxId: string) => pickPoi(bboxId)),
        [options.pickOne],
    );

    const [picks, setPicks] = useState<Record<string, Poi | null>>({});
    const [picking, setPicking] = useState<Set<string>>(() => new Set());
    const [status, setStatus] = useState<PoiPicksStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    // StrictMode double-invokes effects in dev; guard the bootstrap so
    // we don't fire the GET twice on first mount, matching `useKeptBboxes`.
    const bootstrapped = useRef(false);

    const reload = useCallback(async () => {
        setStatus('loading');
        setError(null);
        try {
            const rows = await fetchAll();
            const next: Record<string, Poi | null> = {};
            for (const row of rows) next[row.bbox_id] = row.poi;
            setPicks(next);
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

    const pick = useCallback(
        async (bboxId: string) => {
            setError(null);
            setPicking((s) => {
                const next = new Set(s);
                next.add(bboxId);
                return next;
            });
            try {
                const row = await pickOne(bboxId);
                setPicks((p) => ({ ...p, [row.bbox_id]: row.poi }));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setPicking((s) => {
                    const next = new Set(s);
                    next.delete(bboxId);
                    return next;
                });
            }
        },
        [pickOne],
    );

    return { picks, picking, status, error, pick, reload };
}

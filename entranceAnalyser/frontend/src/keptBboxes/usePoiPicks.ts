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

import {
    fetchPoiPicks,
    patchPoiPickCompleted,
    pickPoi,
    type PoiPickEntry,
    type PoiPickRecord,
} from '../api';

/** Same lifecycle as `useKeptBboxes` for visual consistency. */
export type PoiPicksStatus = 'loading' | 'idle' | 'error';

export interface UsePoiPicksOptions {
    /** Override for the bulk loader, mostly for tests. */
    fetchAll?: () => Promise<PoiPickRecord[]>;
    /** Override for the per-bbox pick action, mostly for tests. */
    pickOne?: (bboxId: string) => Promise<PoiPickRecord>;
    /** Override for PATCH completed, mostly for tests. */
    patchCompleted?: (bboxId: string, completed: boolean) => Promise<PoiPickRecord>;
}

function recordToEntry(row: PoiPickRecord): PoiPickEntry {
    return { poi: row.poi, completed: row.completed ?? false };
}

export interface PoiPicksState {
    /** `picks[bboxId]` is missing when no pick row exists; `poi` is
     *  `null` when Overpass matched nothing inside the cell. */
    picks: Record<string, PoiPickEntry>;
    /** Bbox ids whose `pick(...)` is currently in flight, so the UI
     *  can disable the corresponding button without blocking anything
     *  else on the page. */
    picking: Set<string>;
    /** Bbox ids whose completed flag PATCH is in flight. */
    savingCompleted: Set<string>;
    status: PoiPicksStatus;
    error: string | null;
    pick: (bboxId: string) => Promise<void>;
    /** Persist reviewer "completed" (overview map green dot). */
    setPickCompleted: (bboxId: string, completed: boolean) => Promise<void>;
    /** Drop local pick state after the bbox was removed from `kept_bboxes`. */
    removePickForBbox: (bboxId: string) => void;
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
    const patchOne = useMemo(
        () =>
            options.patchCompleted ??
            ((bboxId: string, completed: boolean) =>
                patchPoiPickCompleted(bboxId, completed)),
        [options.patchCompleted],
    );

    const [picks, setPicks] = useState<Record<string, PoiPickEntry>>({});
    const [picking, setPicking] = useState<Set<string>>(() => new Set());
    const [savingCompleted, setSavingCompleted] = useState<Set<string>>(() => new Set());
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
            const next: Record<string, PoiPickEntry> = {};
            for (const row of rows) next[row.bbox_id] = recordToEntry(row);
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
                setPicks((p) => ({ ...p, [row.bbox_id]: recordToEntry(row) }));
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

    const removePickForBbox = useCallback((bboxId: string) => {
        setPicks((p) => {
            const next = { ...p };
            delete next[bboxId];
            return next;
        });
    }, []);

    const setPickCompleted = useCallback(
        async (bboxId: string, completed: boolean) => {
            setError(null);
            setSavingCompleted((s) => {
                const next = new Set(s);
                next.add(bboxId);
                return next;
            });
            try {
                const row = await patchOne(bboxId, completed);
                setPicks((p) => ({ ...p, [row.bbox_id]: recordToEntry(row) }));
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setSavingCompleted((s) => {
                    const next = new Set(s);
                    next.delete(bboxId);
                    return next;
                });
            }
        },
        [patchOne],
    );

    return {
        picks,
        picking,
        savingCompleted,
        status,
        error,
        pick,
        setPickCompleted,
        removePickForBbox,
        reload,
    };
}

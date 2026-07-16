/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Progress-indicator contract for per-bbox analyses.
//!
//! Defined up front as a union + label map so the kept-bboxes view can
//! render consistent status pills today (all rows are painted
//! `not_started`) and the forthcoming analysis runner can transition
//! rows through the remaining states without touching any component
//! that displays them.

/** Lifecycle of an analysis for one kept bbox, from the UI's point of view. */
export type ProgressStatus =
    | 'not_started'
    | 'queued'
    | 'running'
    | 'active'
    | 'done'
    | 'completed'
    | 'failed';

/** Human-readable label shown inside `<StatusPill />` for each status. */
export const PROGRESS_LABELS: Record<ProgressStatus, string> = {
    not_started: 'Not started',
    queued: 'Queued',
    running: 'Running',
    active: 'Started',
    done: 'Done',
    completed: 'Completed',
    failed: 'Failed',
};

/** Map a cached POI pick to the shared progress union. */
export function progressFromPoiPick(
    pickedPoi: { osm_type: string; osm_id: number } | null | undefined,
    isPicking: boolean,
    pickCompleted: boolean,
): ProgressStatus {
    if (isPicking) return 'running';
    if (pickedPoi !== undefined) {
        if (pickedPoi === null) return 'done';
        if (pickCompleted) return 'completed';
        return 'active';
    }
    return 'not_started';
}

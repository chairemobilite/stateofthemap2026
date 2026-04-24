//! Progress-indicator contract for per-bbox analyses.
//!
//! Defined up front as a union + label map so the kept-bboxes view can
//! render consistent status pills today (all rows are painted
//! `not_started`) and the forthcoming analysis runner can transition
//! rows through the remaining states without touching any component
//! that displays them.

/** Lifecycle of an analysis for one kept bbox, from the UI's point of view. */
export type ProgressStatus = 'not_started' | 'queued' | 'running' | 'done' | 'failed';

/** Human-readable label shown inside `<StatusPill />` for each status. */
export const PROGRESS_LABELS: Record<ProgressStatus, string> = {
    not_started: 'Not started',
    queued: 'Queued',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
};

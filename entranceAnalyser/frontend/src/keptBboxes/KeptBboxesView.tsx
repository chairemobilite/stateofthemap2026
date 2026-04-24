//! Second app screen: lists every kept bbox currently in the database
//! with a per-row analysis-progress pill. Today every row renders
//! `not_started`; the forthcoming analysis runner will flip pills to
//! `running` / `done` / `failed` without requiring changes here.

import type { KeptBbox } from '../api';

import { KeptBboxRow } from './KeptBboxRow';
import type { KeptBboxesStatus } from './useKeptBboxes';

export interface KeptBboxesViewProps {
    keptBboxes: KeptBbox[];
    status: KeptBboxesStatus;
    error: string | null;
}

/**
 * Render the kept-bboxes list screen. Consumes flat props so the view
 * can be unit-tested without the API, mirroring `SamplingPanel`'s shape.
 *
 * @param keptBboxes - Rows to render. May be empty while `status === 'loading'`.
 * @param status - Fetch lifecycle state (`loading` / `idle` / `error`).
 * @param error - Human-readable error message when `status === 'error'`.
 */
export function KeptBboxesView({ keptBboxes, status, error }: KeptBboxesViewProps) {
    return (
        <section className="kept-bboxes-view" aria-label="Kept bboxes">
            <h1>Kept bboxes ({keptBboxes.length})</h1>

            {status === 'loading' && (
                <p className="kept-bboxes-view__status">Loading…</p>
            )}

            {status === 'error' && error && (
                <p className="kept-bboxes-view__error" role="alert">
                    {error}
                </p>
            )}

            {status === 'idle' && keptBboxes.length === 0 && (
                <p className="kept-bboxes-view__empty">
                    No bboxes have been kept yet. Switch to the Sampling
                    screen and keep a few candidates first.
                </p>
            )}

            {keptBboxes.length > 0 && (
                <ul className="kept-bboxes-view__list">
                    {keptBboxes.map((bbox) => (
                        <li key={bbox.id}>
                            <KeptBboxRow bbox={bbox} status="not_started" />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

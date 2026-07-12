/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Tiny presentational badge for a `ProgressStatus`. Tone is driven by
//! `[data-status]` in CSS so the set of visual states can grow without
//! touching this component.

import { PROGRESS_LABELS, type ProgressStatus } from './progress';

export interface StatusPillProps {
    status: ProgressStatus;
}

/**
 * Render a small pill labelled with the human-readable form of `status`.
 *
 * @param status - Current state for the bbox this pill belongs to.
 */
export function StatusPill({ status }: StatusPillProps) {
    return (
        <span className="progress-pill" data-status={status}>
            {PROGRESS_LABELS[status]}
        </span>
    );
}

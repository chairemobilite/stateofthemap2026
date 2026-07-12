/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Map popup body for one kept bbox.
//!
//! Composes the existing `<KeptBboxRow />` (presentational, unchanged)
//! with the new `<PoiPickPanel />` so the map's popup can both show
//! the bbox's headline numbers and trigger the POI-pick step in the
//! same React subtree. Lives in its own file so `KeptBboxesMap`
//! doesn't grow yet another inline component, matching the
//! one-concept-per-file convention used elsewhere in the package.

import type { KeptBbox, Poi } from '../api';
import { KeptBboxRow } from './KeptBboxRow';
import { PoiPickPanel } from './PoiPickPanel';
import type { ProgressStatus } from './progress';

export interface KeptBboxPopupProps {
    bbox: KeptBbox;
    /** `undefined` when no pick yet, `null` when picked-but-empty,
     *  otherwise the picked POI. */
    pickedPoi: Poi | null | undefined;
    /** Reviewer flag from `PATCH /poi_pick` (green overview marker). */
    pickCompleted: boolean;
    /** True while this bbox's pick is in flight. */
    isPicking: boolean;
    /** True while any PATCH /poi_pick decision (completed/reject/unreject) is in flight. */
    isSavingPickDecision?: boolean;
    onPick: (bboxId: string) => void;
    /** Toggle completed; omitted in surfaces that don't persist it. */
    onSetPickCompleted?: (bboxId: string, completed: boolean) => void;
    /** Optional: opens the POI focus map for this bbox. Forwarded to
     *  `<PoiPickPanel />` so the focus button only renders once a
     *  real POI has been picked. */
    onOpenFocus?: (bboxId: string) => void;
    /** True while the focus load for this bbox is in flight. */
    isOpeningFocus?: boolean;
    /** Remove this bbox from `kept_bboxes` (parent runs confirm + `DELETE`). */
    onRemoveFromKept?: (bboxId: string) => void;
    /** True while DELETE is in flight for this bbox. */
    isRemovingKept?: boolean;
}

/** Map the (pickedPoi, isPicking) pair to the existing `ProgressStatus`
 *  union so we reuse the `<StatusPill />` palette without new states.
 *  `pickedPoi === null` (queried but Overpass empty) still counts as
 *  done because the analysis ran and produced a definite answer.
 *  A real POI with `pickCompleted` maps to `completed`. */
function progressFromPick(
    pickedPoi: Poi | null | undefined,
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

export function KeptBboxPopup({
    bbox,
    pickedPoi,
    pickCompleted,
    isPicking,
    isSavingPickDecision = false,
    onPick,
    onSetPickCompleted,
    onOpenFocus,
    isOpeningFocus = false,
    onRemoveFromKept,
    isRemovingKept = false,
}: KeptBboxPopupProps) {
    return (
        <div className="kept-bbox-popup">
            <KeptBboxRow
                bbox={bbox}
                status={progressFromPick(pickedPoi, isPicking, pickCompleted)}
            />
            <PoiPickPanel
                bboxId={bbox.id}
                pickedPoi={pickedPoi}
                pickCompleted={pickCompleted}
                isPicking={isPicking}
                isSavingPickDecision={isSavingPickDecision}
                onPick={onPick}
                onSetPickCompleted={onSetPickCompleted}
                onOpenFocus={onOpenFocus}
                isOpeningFocus={isOpeningFocus}
            />
            {onRemoveFromKept && (
                <div className="kept-bbox-popup__actions">
                    <button
                        type="button"
                        className="kept-bbox-popup__reject"
                        disabled={isRemovingKept}
                        onClick={() => void onRemoveFromKept(bbox.id)}
                    >
                        Remove from kept…
                    </button>
                </div>
            )}
        </div>
    );
}

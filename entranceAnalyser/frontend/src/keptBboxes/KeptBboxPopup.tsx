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
    /** True while this bbox's pick is in flight. */
    isPicking: boolean;
    onPick: (bboxId: string) => void;
}

/** Map the (pickedPoi, isPicking) pair to the existing `ProgressStatus`
 *  union so we reuse the `<StatusPill />` palette without new states.
 *  `pickedPoi === null` (queried but Overpass empty) still counts as
 *  done because the analysis ran and produced a definite answer. */
function progressFromPick(
    pickedPoi: Poi | null | undefined,
    isPicking: boolean,
): ProgressStatus {
    if (isPicking) return 'running';
    if (pickedPoi !== undefined) return 'done';
    return 'not_started';
}

export function KeptBboxPopup({ bbox, pickedPoi, isPicking, onPick }: KeptBboxPopupProps) {
    return (
        <div className="kept-bbox-popup">
            <KeptBboxRow bbox={bbox} status={progressFromPick(pickedPoi, isPicking)} />
            <PoiPickPanel
                bboxId={bbox.id}
                pickedPoi={pickedPoi}
                isPicking={isPicking}
                onPick={onPick}
            />
        </div>
    );
}

//! Popup panel that triggers and displays one POI pick.
//!
//! Three visual states, all rendered from the same component:
//!
//! 1. **Not picked yet** — single "Pick POI" button.
//! 2. **In flight** — same button, disabled, label switches to "Picking…".
//! 3. **Picked** — small definition list with the picked feature's
//!    group, name (from tags), tag highlight, and an OSM permalink.
//!    When `poi === null` the cell was queried but matched nothing,
//!    so we surface "No POI in this cell" instead of feature details.
//!
//! When a real POI is picked, a "POI completed" checkbox lets the
//! reviewer flip the overview marker to green. Reject is intentionally
//! not exposed here: the reviewer needs the imagery context of the
//! focus map (`PoiFocusMap`) to decide whether a POI is unmappable,
//! so the reject affordance lives there only.
//!
//! Pure presentational: lifecycle (`isPicking`, `pickedPoi`) and the
//! click handler are passed in, so the parent (`KeptBboxesMap`) keeps
//! ownership of the pick state via `usePoiPicks`.

import type { Poi } from '../api';

export interface PoiPickPanelProps {
    bboxId: string;
    /** `undefined` when no pick has been requested yet, `null` when
     *  Overpass returned no match, otherwise the picked POI. */
    pickedPoi: Poi | null | undefined;
    /** Reviewer flag (green dot on overview map when true). */
    pickCompleted: boolean;
    /** True while this specific bbox's pick request is in flight. */
    isPicking: boolean;
    /** True while any PATCH /poi_pick decision (completed toggle,
     *  reject from focus map, unreject) is in flight for this bbox. */
    isSavingPickDecision?: boolean;
    onPick: (bboxId: string) => void;
    /** Toggle overview "completed" state; only shown when a real POI exists. */
    onSetPickCompleted?: (bboxId: string, completed: boolean) => void;
    /** Optional handler that opens the POI focus map. The button is
     *  rendered (and enabled) only when a real POI was picked, since
     *  the focus query is anchored on the pick's centre coords.
     *  Omitting the handler omits the button — keeps the panel
     *  reusable in surfaces that don't have a focus view. */
    onOpenFocus?: (bboxId: string) => void;
    /** True while this bbox's focus load is in flight, so the button
     *  can flip to "Loading…" without leaving the popup. */
    isOpeningFocus?: boolean;
}

/** Minimal fallback when `tags.name` is missing — keeps the panel
 *  readable for unnamed features without burying the OSM id. */
function displayName(poi: Poi): string {
    return poi.tags['name'] ?? `${poi.osm_type} ${poi.osm_id}`;
}

/** Single tag highlight: prefer the group's defining key
 *  (`shop`/`amenity`/etc.), fall back to the first non-`name` tag.
 *  Keeps the panel compact -- the full tag list isn't useful in a
 *  popup and the picked-group label already conveys the type. */
function highlightTag(poi: Poi): string | null {
    const groupKey = poi.group.replace(/s$/, ''); // shops -> shop, amenities -> amenitie (close enough)
    const candidates = [groupKey, 'amenity', 'shop', 'tourism', 'leisure', 'office', 'historic'];
    for (const key of candidates) {
        const value = poi.tags[key];
        if (value) return `${key}=${value}`;
    }
    for (const [key, value] of Object.entries(poi.tags)) {
        if (key !== 'name') return `${key}=${value}`;
    }
    return null;
}

export function PoiPickPanel({
    bboxId,
    pickedPoi,
    pickCompleted,
    isPicking,
    isSavingPickDecision = false,
    onPick,
    onSetPickCompleted,
    onOpenFocus,
    isOpeningFocus = false,
}: PoiPickPanelProps) {
    const hasPicked = pickedPoi !== undefined;

    if (!hasPicked) {
        return (
            <div className="poi-pick-panel">
                <button
                    type="button"
                    className="poi-pick-panel__button"
                    onClick={() => onPick(bboxId)}
                    disabled={isPicking}
                >
                    {isPicking ? 'Picking…' : 'Pick POI'}
                </button>
            </div>
        );
    }

    if (pickedPoi === null) {
        return (
            <div className="poi-pick-panel">
                <p className="poi-pick-panel__empty">No POI in this cell.</p>
            </div>
        );
    }

    const tag = highlightTag(pickedPoi);
    /** Synthetic pick for custom lat/lon cells (`osm_id` 0 is not a real OSM object). */
    const showOsmPermalink = !(pickedPoi.osm_type === 'node' && pickedPoi.osm_id === 0);
    const osmUrl = `https://www.openstreetmap.org/${pickedPoi.osm_type}/${pickedPoi.osm_id}`;
    return (
        <div className="poi-pick-panel">
            <dl className="poi-pick-panel__details">
                <dt>Picked POI</dt>
                <dd>{displayName(pickedPoi)}</dd>
                <dt>Group</dt>
                <dd>{pickedPoi.group}</dd>
                {tag && (
                    <>
                        <dt>Tag</dt>
                        <dd>
                            <code>{tag}</code>
                        </dd>
                    </>
                )}
                {showOsmPermalink ? (
                    <>
                        <dt>OSM</dt>
                        <dd>
                            <a href={osmUrl} target="_blank" rel="noreferrer noopener">
                                {pickedPoi.osm_type}/{pickedPoi.osm_id}
                            </a>
                        </dd>
                    </>
                ) : (
                    <>
                        <dt>OSM</dt>
                        <dd>— (sampling centroid, not an OSM id)</dd>
                    </>
                )}
            </dl>
            {onOpenFocus && (
                <button
                    type="button"
                    className="poi-pick-panel__focus-button"
                    onClick={() => onOpenFocus(bboxId)}
                    disabled={isOpeningFocus}
                >
                    {isOpeningFocus ? 'Loading…' : 'Open focus map'}
                </button>
            )}
            {onSetPickCompleted && (
                <label className="poi-pick-panel__completed">
                    <input
                        type="checkbox"
                        checked={pickCompleted}
                        disabled={isSavingPickDecision}
                        onChange={(e) => onSetPickCompleted(bboxId, e.target.checked)}
                    />{' '}
                    Mark POI completed (green on overview map)
                </label>
            )}
        </div>
    );
}

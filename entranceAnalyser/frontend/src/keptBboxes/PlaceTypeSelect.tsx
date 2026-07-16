/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Dropdown for the reviewer-chosen place type of a POI pick.
//!
//! Shows the stored `place_type` when set, otherwise the value
//! autodetected from the POI's OSM tags (mirrors the SQL fallback in
//! `backend/src/storage.rs`), otherwise "— (pick one)". Picking an
//! option persists it via `PATCH /poi_pick`.

import { type PlaceType, type Poi } from '../api';
import { detectPlaceType, PLACE_TYPES, PLACE_TYPE_LABELS } from './placeTypes';

export { detectPlaceType } from './placeTypes';

export interface PlaceTypeSelectProps {
    /** Picked POI whose tags feed the autodetection. */
    poi: Poi;
    /** Stored reviewer choice (`null`/`undefined` = not set). */
    placeType: PlaceType | null | undefined;
    /** True while a PATCH for this bbox is in flight. */
    disabled?: boolean;
    onChange: (placeType: PlaceType | null) => void;
}

/**
 * Render the place-type dropdown. The displayed value is the stored
 * choice, falling back to the tag-detected type (not yet persisted).
 * @param props See {@link PlaceTypeSelectProps}.
 */
export function PlaceTypeSelect({ poi, placeType, disabled = false, onChange }: PlaceTypeSelectProps) {
    const detected = detectPlaceType(poi.tags);
    const value = placeType ?? detected ?? '';
    return (
        <label className="place-type-select">
            Place type{' '}
            <select
                value={value}
                disabled={disabled}
                onChange={(e) => onChange((e.target.value || null) as PlaceType | null)}
            >
                <option value="">— (pick one)</option>
                {PLACE_TYPES.map((t) => (
                    <option key={t} value={t}>
                        {PLACE_TYPE_LABELS[t]}
                        {placeType == null && detected === t ? ' (detected)' : ''}
                    </option>
                ))}
            </select>
        </label>
    );
}

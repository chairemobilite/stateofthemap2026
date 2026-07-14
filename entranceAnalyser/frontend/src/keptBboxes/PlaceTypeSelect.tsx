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
//! `backend/src/storage.rs`), otherwise "— (pick one)". There is no
//! "other" option: leaving it unset keeps tag-based classification.
//! Picking an option persists it via `PATCH /poi_pick`; the detected
//! value is also persisted on change so what you see is what is stored.

import { PLACE_TYPES, type PlaceType, type Poi } from '../api';

/** Human labels, in dropdown order. */
const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
    university: 'University',
    cegep: 'College / CEGEP',
    hospital: 'Hospital',
    industrial: 'Industrial',
    park: 'Park',
};

/**
 * Classify a POI from its OSM tags — same rules (and order) as the
 * SQL fallback in `quebec_place_type_stats`. Returns `null` when no
 * rule matches (the "other" case: the dropdown stays empty).
 * @param tags Raw OSM tags of the picked POI.
 */
export function detectPlaceType(tags: Record<string, string>): PlaceType | null {
    if (
        tags['amenity'] === 'university' ||
        tags['education'] === 'university' ||
        tags['building'] === 'university'
    ) {
        return 'university';
    }
    if (tags['amenity'] === 'college' || tags['education'] === 'college') return 'cegep';
    if (tags['amenity'] === 'hospital' || tags['healthcare'] === 'hospital') return 'hospital';
    if (tags['building'] === 'industrial' || tags['man_made'] === 'works') return 'industrial';
    if (tags['leisure'] === 'park') return 'park';
    return null;
}

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

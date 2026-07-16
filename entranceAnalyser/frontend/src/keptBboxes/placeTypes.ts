/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

/**
 * Quebec POI place-type taxonomy. Keep in sync with
 * `backend/src/place_types.rs` (`PLACE_TYPES` and `TAG_FALLBACK_SQL`).
 */

/** Reviewer-selectable place types, in dropdown order. */
export const PLACE_TYPES = [
    'university_small',
    'university',
    'cegep',
    'hospital',
    'national_park',
    'shopping_center',
    'sport_stadium',
    'conference_center',
    'airport',
    'train_bus_station',
    'ski_resort',
    'primary_school',
    'secondary_school',
    'regional_park',
    'municipal_park',
    'large_clinic',
    'hospice',
    'elderly_residence',
    'museum_cultural',
    'concert_hall',
    'sport_pitch',
    'sport_center',
    'governmental_office',
    'industrial',
    'other',
] as const;

export type PlaceType = (typeof PLACE_TYPES)[number];

/** Human labels for dropdown and stats tables, keyed by slug. */
export const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
    university_small: 'University (small campus)',
    university: 'University',
    cegep: 'College / CEGEP',
    hospital: 'Hospital',
    national_park: 'National park',
    shopping_center: 'Shopping center',
    sport_stadium: 'Sport stadium',
    conference_center: 'Conference center',
    airport: 'Airport',
    train_bus_station: 'Train or bus station',
    ski_resort: 'Ski resort',
    primary_school: 'Primary school',
    secondary_school: 'Secondary school',
    regional_park: 'Regional park',
    municipal_park: 'Municipal park',
    large_clinic: 'Large clinic',
    hospice: 'Hospice',
    elderly_residence: 'Elderly residence',
    museum_cultural: 'Museum or cultural center',
    concert_hall: 'Concert hall',
    sport_pitch: 'Sport pitch',
    sport_center: 'Sport center',
    governmental_office: 'Governmental office',
    industrial: 'Industrial',
    other: 'Other',
};

/** Labels for the Quebec stats table, in display order (includes `other`). */
export const QUEBEC_PLACE_TYPE_LABELS: ReadonlyArray<readonly [PlaceType | 'other', string]> =
    PLACE_TYPES.map((t) => [t, PLACE_TYPE_LABELS[t]] as const);

function isUniversity(tags: Record<string, string>): boolean {
    return (
        tags['amenity'] === 'university' ||
        tags['education'] === 'university' ||
        tags['building'] === 'university'
    );
}

/**
 * Classify a POI from its OSM tags — same rules (and order) as the SQL
 * fallback in `quebec_place_type_stats`. Returns `null` when no rule
 * matches so the reviewer can pick manually (including `other`).
 * @param tags Raw OSM tags of the picked POI.
 */
export function detectPlaceType(tags: Record<string, string>): PlaceType | null {
    if (tags['branch'] && isUniversity(tags)) return 'university_small';
    if (isUniversity(tags)) return 'university';
    if (tags['amenity'] === 'college' || tags['education'] === 'college') return 'cegep';
    if (tags['amenity'] === 'hospital' || tags['healthcare'] === 'hospital') return 'hospital';
    if (
        tags['boundary'] === 'protected_area' &&
        (tags['protect_class'] === '2' ||
            /parc national|national park|parc marin/i.test(tags['name'] ?? ''))
    ) {
        return 'national_park';
    }
    if (tags['shop'] === 'mall' || tags['landuse'] === 'retail') return 'shopping_center';
    if (tags['leisure'] === 'stadium' || tags['building'] === 'stadium') return 'sport_stadium';
    if (tags['amenity'] === 'conference_centre' || tags['amenity'] === 'events_venue') {
        return 'conference_center';
    }
    if (['aerodrome', 'terminal', 'international'].includes(tags['aeroway'] ?? '')) {
        return 'airport';
    }
    if (
        tags['railway'] === 'station' ||
        tags['railway'] === 'halt' ||
        tags['amenity'] === 'bus_station' ||
        tags['public_transport'] === 'station'
    ) {
        return 'train_bus_station';
    }
    if (tags['landuse'] === 'winter_sports' || tags['piste:type']) return 'ski_resort';
    if (
        tags['amenity'] === 'kindergarten' ||
        (tags['amenity'] === 'school' && ['0', '1'].includes(tags['isced:level'] ?? ''))
    ) {
        return 'primary_school';
    }
    if (tags['amenity'] === 'school' && ['2', '3'].includes(tags['isced:level'] ?? '')) {
        return 'secondary_school';
    }
    if (tags['boundary'] === 'protected_area' && tags['protect_class'] === '3') {
        return 'regional_park';
    }
    if (tags['leisure'] === 'park') return 'municipal_park';
    if (tags['amenity'] === 'clinic' || ['centre', 'clinic'].includes(tags['healthcare'] ?? '')) {
        return 'large_clinic';
    }
    if (tags['healthcare'] === 'hospice' || tags['social_facility'] === 'hospice') {
        return 'hospice';
    }
    if (['nursing_home', 'assisted_living', 'senior'].includes(tags['social_facility'] ?? '')) {
        return 'elderly_residence';
    }
    if (
        tags['tourism'] === 'museum' ||
        tags['amenity'] === 'arts_centre' ||
        tags['building'] === 'museum'
    ) {
        return 'museum_cultural';
    }
    if (
        ['theatre', 'music_venue', 'concert_hall'].includes(tags['amenity'] ?? '') ||
        tags['building'] === 'theatre'
    ) {
        return 'concert_hall';
    }
    if (tags['leisure'] === 'pitch' || tags['leisure'] === 'track') return 'sport_pitch';
    if (
        tags['leisure'] === 'sports_centre' ||
        tags['building'] === 'sports_centre' ||
        tags['building'] === 'sports_hall'
    ) {
        return 'sport_center';
    }
    if (
        tags['office'] === 'government' ||
        tags['building'] === 'government' ||
        tags['amenity'] === 'townhall'
    ) {
        return 'governmental_office';
    }
    if (tags['building'] === 'industrial' || tags['man_made'] === 'works') return 'industrial';
    return null;
}

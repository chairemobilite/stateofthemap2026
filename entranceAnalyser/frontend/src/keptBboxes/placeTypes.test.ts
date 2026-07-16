/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it } from 'vitest';

import { detectPlaceType } from './placeTypes';

describe('detectPlaceType', () => {
    it.each([
        [{ amenity: 'university', branch: 'Campus MIL' }, 'university_small'],
        [{ amenity: 'university' }, 'university'],
        [{ education: 'university' }, 'university'],
        [{ amenity: 'college' }, 'cegep'],
        [{ amenity: 'hospital' }, 'hospital'],
        [{ boundary: 'protected_area', protect_class: '2' }, 'national_park'],
        [{ shop: 'mall' }, 'shopping_center'],
        [{ leisure: 'stadium' }, 'sport_stadium'],
        [{ amenity: 'conference_centre' }, 'conference_center'],
        [{ aeroway: 'aerodrome' }, 'airport'],
        [{ railway: 'station' }, 'train_bus_station'],
        [{ landuse: 'winter_sports' }, 'ski_resort'],
        [{ amenity: 'kindergarten' }, 'primary_school'],
        [{ amenity: 'school', 'isced:level': '2' }, 'secondary_school'],
        [{ boundary: 'protected_area', protect_class: '3' }, 'regional_park'],
        [{ leisure: 'park' }, 'municipal_park'],
        [{ amenity: 'clinic' }, 'large_clinic'],
        [{ social_facility: 'nursing_home' }, 'elderly_residence'],
        [{ tourism: 'museum' }, 'museum_cultural'],
        [{ amenity: 'theatre' }, 'concert_hall'],
        [{ leisure: 'pitch' }, 'sport_pitch'],
        [{ leisure: 'sports_centre' }, 'sport_center'],
        [{ office: 'government' }, 'governmental_office'],
        [{ building: 'industrial' }, 'industrial'],
        [{ shop: 'bakery' }, null],
        [{}, null],
    ] as const)('classifies %o as %s', (tags, expected) => {
        expect(detectPlaceType({ ...tags })).toBe(expected);
    });
});

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Quebec POI place-type taxonomy for reviewer picks and stats.
//!
//! [`PLACE_TYPES`] is the allow-list for `PATCH /poi_pick { place_type }`.
//! [`TAG_FALLBACK_SQL`] mirrors the TypeScript rules in
//! `frontend/src/keptBboxes/placeTypes.ts` (first match wins).

/// Reviewer-selectable place types, in dropdown order.
pub const PLACE_TYPES: [&str; 25] = [
    "university_small",
    "university",
    "cegep",
    "hospital",
    "national_park",
    "shopping_center",
    "sport_stadium",
    "conference_center",
    "airport",
    "train_bus_station",
    "ski_resort",
    "primary_school",
    "secondary_school",
    "regional_park",
    "municipal_park",
    "large_clinic",
    "hospice",
    "elderly_residence",
    "museum_cultural",
    "concert_hall",
    "sport_pitch",
    "sport_center",
    "governmental_office",
    "industrial",
    "other",
];

/// SQL `CASE` body classifying a `tags` jsonb column when the reviewer
/// has not set `place_type`. Keep in sync with `detectPlaceType` in the
/// frontend.
pub const TAG_FALLBACK_SQL: &str = "\
     WHEN tags->>'branch' IS NOT NULL \
       AND (tags->>'amenity' = 'university' \
         OR tags->>'education' = 'university' \
         OR tags->>'building' = 'university') THEN 'university_small' \
     WHEN tags->>'amenity' = 'university' \
       OR tags->>'education' = 'university' \
       OR tags->>'building' = 'university' THEN 'university' \
     WHEN tags->>'amenity' = 'college' \
       OR tags->>'education' = 'college' THEN 'cegep' \
     WHEN tags->>'amenity' = 'hospital' \
       OR tags->>'healthcare' = 'hospital' THEN 'hospital' \
     WHEN tags->>'boundary' = 'protected_area' \
       AND (tags->>'protect_class' = '2' \
         OR tags->>'name' ILIKE '%Parc national%' \
         OR tags->>'name' ILIKE '%National Park%' \
         OR tags->>'name' ILIKE '%parc marin%') THEN 'national_park' \
     WHEN tags->>'shop' = 'mall' \
       OR tags->>'landuse' = 'retail' THEN 'shopping_center' \
     WHEN tags->>'leisure' = 'stadium' \
       OR tags->>'building' = 'stadium' THEN 'sport_stadium' \
     WHEN tags->>'amenity' IN ('conference_centre', 'events_venue') \
       THEN 'conference_center' \
     WHEN tags->>'aeroway' IN ('aerodrome', 'terminal', 'international') \
       THEN 'airport' \
     WHEN tags->>'railway' IN ('station', 'halt') \
       OR tags->>'amenity' = 'bus_station' \
       OR tags->>'public_transport' = 'station' THEN 'train_bus_station' \
     WHEN tags->>'landuse' = 'winter_sports' \
       OR tags ? 'piste:type' THEN 'ski_resort' \
     WHEN tags->>'amenity' = 'kindergarten' \
       OR (tags->>'amenity' = 'school' \
         AND tags->>'isced:level' IN ('0', '1')) THEN 'primary_school' \
     WHEN tags->>'amenity' = 'school' \
       AND tags->>'isced:level' IN ('2', '3') THEN 'secondary_school' \
     WHEN tags->>'boundary' = 'protected_area' \
       AND tags->>'protect_class' = '3' THEN 'regional_park' \
     WHEN tags->>'leisure' = 'park' THEN 'municipal_park' \
     WHEN tags->>'amenity' = 'clinic' \
       OR tags->>'healthcare' IN ('centre', 'clinic') THEN 'large_clinic' \
     WHEN tags->>'healthcare' = 'hospice' \
       OR tags->>'social_facility' = 'hospice' THEN 'hospice' \
     WHEN tags->>'social_facility' IN ('nursing_home', 'assisted_living', 'senior') \
       THEN 'elderly_residence' \
     WHEN tags->>'tourism' = 'museum' \
       OR tags->>'amenity' = 'arts_centre' \
       OR tags->>'building' = 'museum' THEN 'museum_cultural' \
     WHEN tags->>'amenity' IN ('theatre', 'music_venue', 'concert_hall') \
       OR tags->>'building' = 'theatre' THEN 'concert_hall' \
     WHEN tags->>'leisure' IN ('pitch', 'track') THEN 'sport_pitch' \
     WHEN tags->>'leisure' = 'sports_centre' \
       OR tags->>'building' IN ('sports_centre', 'sports_hall') \
       THEN 'sport_center' \
     WHEN tags->>'office' = 'government' \
       OR tags->>'building' = 'government' \
       OR tags->>'amenity' = 'townhall' THEN 'governmental_office' \
     WHEN tags->>'building' = 'industrial' \
       OR tags->>'man_made' = 'works' THEN 'industrial' \
     ELSE 'other'";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_types_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for t in PLACE_TYPES {
            assert!(seen.insert(t), "duplicate place type: {t}");
        }
    }
}

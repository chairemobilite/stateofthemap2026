/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Reviewer-facing POI labels derived from OSM tags.
//!
//! When a feature carries `branch=`, the cached pick stores
//! `name | branch` in `Poi.tags["name"]` so campus-level POIs read
//! distinctly in the list and focus map.

use std::collections::BTreeMap;

use crate::overpass::{OsmType, Poi};

const NAME_KEYS: [&str; 3] = ["name", "name:fr", "name:en"];

/// Prefer `name`, then `name:fr`, then `name:en`.
pub fn base_name_from_tags(tags: &BTreeMap<String, String>) -> Option<String> {
    for key in NAME_KEYS {
        if let Some(value) = tags.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            return Some(value.to_string());
        }
    }
    None
}

/// Trimmed `branch` tag, when present.
pub fn branch_from_tags(tags: &BTreeMap<String, String>) -> Option<String> {
    tags.get("branch")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Build the label shown in the UI: `name | branch` when both exist.
pub fn format_poi_display_name(tags: &BTreeMap<String, String>) -> Option<String> {
    let base = base_name_from_tags(tags)?;
    match branch_from_tags(tags) {
        Some(branch) => Some(format!("{base} | {branch}")),
        None => Some(base),
    }
}

/// Copy name / branch keys from fresh OSM tags, then write the composite
/// into `tags["name"]` on the pick.
pub fn sync_poi_name_from_osm_tags(poi: &mut Poi, osm_tags: &BTreeMap<String, String>) {
    for key in NAME_KEYS {
        if let Some(value) = osm_tags.get(key) {
            poi.tags.insert(key.to_string(), value.clone());
        }
    }
    if let Some(branch) = branch_from_tags(osm_tags) {
        poi.tags.insert("branch".to_string(), branch);
    }
    if let Some(display) = format_poi_display_name(&poi.tags) {
        poi.tags.insert("name".to_string(), display);
    }
}

/// Apply the composite label from the POI's own tags (after Overpass pick).
pub fn apply_display_name_to_poi(poi: &mut Poi) {
    if let Some(display) = format_poi_display_name(&poi.tags) {
        poi.tags.insert("name".to_string(), display);
    }
}

/// True when the pick still shows the osm-type/id fallback, has no name,
/// or has a `branch` tag that is not yet reflected in `tags["name"]`.
pub fn poi_needs_name_refresh(poi: &Poi) -> bool {
    if poi.osm_type == OsmType::Node && poi.osm_id == 0 {
        return false;
    }
    let stored = poi
        .tags
        .get("name")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    match stored {
        None => true,
        Some(name) if name == osm_id_fallback(poi) => true,
        Some(name) => {
            if let Some(expected) = format_poi_display_name(&poi.tags) {
                expected != name
            } else {
                false
            }
        }
    }
}

/// Fallback label when no `name` tag is stored.
pub fn osm_id_fallback(poi: &Poi) -> String {
    format!("{} {}", poi.osm_type.as_str(), poi.osm_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn tags(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn format_name_and_branch() {
        let t = tags(&[("name", "UQTR"), ("branch", "Drummondville")]);
        assert_eq!(
            format_poi_display_name(&t).as_deref(),
            Some("UQTR | Drummondville")
        );
    }

    #[test]
    fn format_name_without_branch() {
        let t = tags(&[("name", "McGill University")]);
        assert_eq!(
            format_poi_display_name(&t).as_deref(),
            Some("McGill University")
        );
    }

    #[test]
    fn prefers_name_fr_when_name_missing() {
        let t = tags(&[("name:fr", "Université de Montréal")]);
        assert_eq!(
            format_poi_display_name(&t).as_deref(),
            Some("Université de Montréal")
        );
    }

    #[test]
    fn sync_writes_composite_into_name() {
        let osm = tags(&[
            ("name", "UQAM"),
            ("branch", "Campus Longueuil"),
            ("amenity", "university"),
        ]);
        let mut poi = Poi {
            osm_type: OsmType::Way,
            osm_id: 1,
            center: [0.0, 0.0],
            tags: BTreeMap::new(),
            group: "amenities".to_string(),
        };
        sync_poi_name_from_osm_tags(&mut poi, &osm);
        assert_eq!(poi.tags.get("name").map(String::as_str), Some("UQAM | Campus Longueuil"));
        assert_eq!(poi.tags.get("branch").map(String::as_str), Some("Campus Longueuil"));
    }
}

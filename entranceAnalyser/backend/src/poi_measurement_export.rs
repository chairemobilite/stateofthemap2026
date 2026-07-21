/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Per-POI CSV export joining cached picks with focus-map measurements.

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::focus_measurements::{
    EntranceKind, MeasurementPurpose, PoiFocusMeasurement,
};
use crate::measurement_destination_warnings::{haversine_distance_m, measurement_endpoint};
use crate::poi_display_name::format_poi_display_name;
use crate::storage::PoiPickPayload;

/// Driving-road purposes in fallback order when `to_nearest_driving_road`
/// is missing (walking/cycling/driving combos fold into driving).
const DRIVING_ROAD_PURPOSE_PRIORITY: [MeasurementPurpose; 3] = [
    MeasurementPurpose::ToNearestDrivingRoad,
    MeasurementPurpose::ToNearestWalkingCyclingDrivingNetwork,
    MeasurementPurpose::ToNearestWalkingDrivingNetwork,
];

const CSV_HEADERS: &[&str] = &[
    "osm_id",
    "name",
    "centroid_base",
    "centroid_lat",
    "centroid_lon",
    "main_entrance_lat",
    "main_entrance_lon",
    "category",
    "cohort",
    "walking_distance_centroid_to_main_entrance_m",
    "walking_distance_centroid_to_nearest_driving_road_m",
    "walking_distance_centroid_to_nearest_transit_stop_m",
    "walking_distance_main_entrance_to_nearest_driving_road_m",
    "walking_distance_main_entrance_to_nearest_transit_stop_m",
    "is_same_nearest_driving_road",
    "is_same_transit_stop",
    "euclidean_distance_centroid_to_main_entrance_m",
    "absolute_difference_nearest_road_distance_m",
    "absolute_difference_nearest_transit_stop_distance_m",
    "reversed_measurements",
];

fn is_centroid_entrance(kind: EntranceKind) -> bool {
    matches!(
        kind,
        EntranceKind::CentroidMainBuilding
            | EntranceKind::CentroidMultipleBuildings
            | EntranceKind::CentroidArea
            | EntranceKind::CentroidParcel
    )
}

fn centroid_base_label(kind: EntranceKind) -> &'static str {
    match kind {
        EntranceKind::CentroidMainBuilding => "building",
        EntranceKind::CentroidMultipleBuildings => "multiple buildings",
        EntranceKind::CentroidArea => "area",
        EntranceKind::CentroidParcel => "parcel",
        _ => "",
    }
}

fn prefer_centroid_entrance_walk(
    candidate: &PoiFocusMeasurement,
    current: &PoiFocusMeasurement,
) -> bool {
    let c_main = candidate.measurement_type == MeasurementPurpose::ToNearestMainEntrance;
    let cur_main = current.measurement_type == MeasurementPurpose::ToNearestMainEntrance;
    if c_main && !cur_main {
        true
    } else if cur_main && !c_main {
        false
    } else {
        candidate.created_at > current.created_at
    }
}

fn is_entrance_targeting(purpose: MeasurementPurpose) -> bool {
    matches!(
        purpose,
        MeasurementPurpose::ToNearestEntrance | MeasurementPurpose::ToNearestMainEntrance
    )
}

fn measurement_start(coords: &[[f64; 2]]) -> Option<[f64; 2]> {
    coords.first().copied()
}

fn near_point(a: [f64; 2], b: [f64; 2], radius_m: f64) -> bool {
    haversine_distance_m(a[0], a[1], b[0], b[1]) <= radius_m
}

fn pick_centroid_to_main_walk<'a>(
    measurements: &'a [&PoiFocusMeasurement],
) -> Option<&'a PoiFocusMeasurement> {
    let mut best: Option<&PoiFocusMeasurement> = None;
    for m in measurements {
        if !is_entrance_targeting(m.measurement_type) || !is_centroid_entrance(m.entrance_type) {
            continue;
        }
        best = Some(match best {
            None => m,
            Some(current) if prefer_centroid_entrance_walk(m, current) => m,
            Some(current) => current,
        });
    }
    best
}

fn average_starts(measurements: &[&PoiFocusMeasurement]) -> Option<[f64; 2]> {
    let points: Vec<[f64; 2]> = measurements
        .iter()
        .filter_map(|m| measurement_start(&m.coordinates))
        .collect();
    if points.is_empty() {
        return None;
    }
    let n = points.len() as f64;
    Some([
        points.iter().map(|p| p[0]).sum::<f64>() / n,
        points.iter().map(|p| p[1]).sum::<f64>() / n,
    ])
}

/// Vote which of two candidate points is the centroid vs the main entrance,
/// using every *other* measurement (starts only — anchors sit at the first
/// vertex).
fn label_anchor_points(
    point_a: [f64; 2],
    point_b: [f64; 2],
    measurements: &[&PoiFocusMeasurement],
    skip_id: Uuid,
    match_radius_m: f64,
) -> ([f64; 2], [f64; 2]) {
    let mut a_centroid_votes = 0usize;
    let mut b_centroid_votes = 0usize;
    let mut a_main_votes = 0usize;
    let mut b_main_votes = 0usize;

    for m in measurements {
        if m.id == skip_id {
            continue;
        }
        let Some(start) = measurement_start(&m.coordinates) else {
            continue;
        };
        let near_a = near_point(start, point_a, match_radius_m);
        let near_b = near_point(start, point_b, match_radius_m);
        if is_centroid_entrance(m.entrance_type) {
            if near_a {
                a_centroid_votes += 1;
            }
            if near_b {
                b_centroid_votes += 1;
            }
        } else if m.entrance_type == EntranceKind::Main {
            if near_a {
                a_main_votes += 1;
            }
            if near_b {
                b_main_votes += 1;
            }
        }
    }

    // Centroid: more centroid-anchor starts land here; main: more main-anchor starts.
    let a_is_centroid = a_centroid_votes > b_centroid_votes
        || (a_centroid_votes == b_centroid_votes && a_main_votes <= b_main_votes);
    if a_is_centroid {
        (point_a, point_b)
    } else {
        (point_b, point_a)
    }
}

/// Infer centroid and main-entrance positions.
///
/// 1. Take the two extremities of the centroid → main-entrance walk.
/// 2. Use every other measurement's **start** (the anchor vertex) to decide
///    which extremity is the centroid and which is the main entrance.
pub fn infer_common_anchors(
    measurements: &[&PoiFocusMeasurement],
    match_radius_m: f64,
) -> (Option<[f64; 2]>, Option<[f64; 2]>, Vec<String>) {
    if let Some(walk) = pick_centroid_to_main_walk(measurements) {
        let (Some(point_a), Some(point_b)) = (
            measurement_start(&walk.coordinates),
            measurement_endpoint(&walk.coordinates),
        ) else {
            return (None, None, Vec::new());
        };

        let (centroid, main_entrance) = label_anchor_points(
            point_a,
            point_b,
            measurements,
            walk.id,
            match_radius_m,
        );

        let mut reversed = detect_reversed_measurements(
            measurements,
            Some(centroid),
            Some(main_entrance),
            match_radius_m,
            Some(walk.id),
        );
        let walk_start = measurement_start(&walk.coordinates).unwrap();
        if !near_point(walk_start, centroid, match_radius_m)
            && near_point(walk_start, main_entrance, match_radius_m)
        {
            reversed.push(format!(
                "{}: polyline start/end appear swapped (id={})",
                measurement_label(walk),
                walk.id
            ));
        }

        return (Some(centroid), Some(main_entrance), reversed);
    }

    // No entrance-targeting walk: fall back to mean starts per anchor family.
    let centroid_rows: Vec<&PoiFocusMeasurement> = measurements
        .iter()
        .copied()
        .filter(|m| is_centroid_entrance(m.entrance_type))
        .collect();
    let main_rows: Vec<&PoiFocusMeasurement> = measurements
        .iter()
        .copied()
        .filter(|m| m.entrance_type == EntranceKind::Main)
        .collect();
    (
        average_starts(&centroid_rows),
        average_starts(&main_rows),
        Vec::new(),
    )
}

fn measurement_label(m: &PoiFocusMeasurement) -> String {
    format!("{} ({})", m.measurement_type, m.entrance_type)
}

/// Flag polylines whose start is not on the expected anchor.
fn detect_reversed_measurements(
    measurements: &[&PoiFocusMeasurement],
    centroid: Option<[f64; 2]>,
    main_entrance: Option<[f64; 2]>,
    match_radius_m: f64,
    skip_id: Option<Uuid>,
) -> Vec<String> {
    let (Some(centroid_pt), Some(main_pt)) = (centroid, main_entrance) else {
        return Vec::new();
    };

    let mut reversed = Vec::new();
    for m in measurements {
        if skip_id == Some(m.id) {
            continue;
        }
        let (Some(start), Some(end)) = (
            measurement_start(&m.coordinates),
            measurement_endpoint(&m.coordinates),
        ) else {
            continue;
        };
        let start_near_centroid = near_point(start, centroid_pt, match_radius_m);
        let start_near_main = near_point(start, main_pt, match_radius_m);
        let end_near_centroid = near_point(end, centroid_pt, match_radius_m);
        let end_near_main = near_point(end, main_pt, match_radius_m);

        let flipped = if is_centroid_entrance(m.entrance_type)
            && is_entrance_targeting(m.measurement_type)
        {
            // Centroid → entrance walk: start on centroid, end on main.
            (!start_near_centroid && end_near_centroid && start_near_main)
                || (end_near_main && !start_near_centroid && !end_near_centroid)
        } else if is_centroid_entrance(m.entrance_type) {
            // Other centroid-anchored walks: start on centroid.
            !start_near_centroid && end_near_centroid && !end_near_main
        } else if m.entrance_type == EntranceKind::Main {
            // Main-anchored walks: start on main entrance.
            !start_near_main && end_near_main && !end_near_centroid
        } else {
            false
        };

        if flipped {
            reversed.push(format!(
                "{}: polyline start/end appear swapped (id={})",
                measurement_label(m),
                m.id
            ));
        }
    }
    reversed
}

fn latest_measurement<'a>(
    measurements: &'a [&PoiFocusMeasurement],
    purpose: MeasurementPurpose,
    entrance: EntranceKind,
) -> Option<&'a PoiFocusMeasurement> {
    measurements
        .iter()
        .copied()
        .filter(|m| m.measurement_type == purpose && m.entrance_type == entrance)
        .max_by_key(|m| m.created_at)
}

/// Latest row for `purpose` across any `centroid_*` anchor.
fn latest_centroid_measurement<'a>(
    measurements: &'a [&PoiFocusMeasurement],
    purpose: MeasurementPurpose,
) -> Option<&'a PoiFocusMeasurement> {
    measurements
        .iter()
        .copied()
        .filter(|m| is_centroid_entrance(m.entrance_type) && m.measurement_type == purpose)
        .max_by_key(|m| m.created_at)
}

fn latest_driving_measurement<'a>(
    measurements: &'a [&PoiFocusMeasurement],
    entrance: EntranceKind,
) -> Option<&'a PoiFocusMeasurement> {
    for purpose in DRIVING_ROAD_PURPOSE_PRIORITY {
        if let Some(m) = latest_measurement(measurements, purpose, entrance) {
            return Some(m);
        }
    }
    None
}

fn latest_centroid_driving_measurement<'a>(
    measurements: &'a [&PoiFocusMeasurement],
) -> Option<&'a PoiFocusMeasurement> {
    for purpose in DRIVING_ROAD_PURPOSE_PRIORITY {
        if let Some(m) = latest_centroid_measurement(measurements, purpose) {
            return Some(m);
        }
    }
    None
}

fn optional_i32(n: Option<i32>) -> String {
    n.map(|v| v.to_string()).unwrap_or_default()
}

fn optional_f64(n: Option<f64>) -> String {
    n.map(|v| format!("{v:.3}")).unwrap_or_default()
}

fn optional_bool(value: Option<bool>) -> String {
    match value {
        Some(true) => "true".to_string(),
        Some(false) => "false".to_string(),
        None => String::new(),
    }
}

fn csv_cell(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn resolve_category(
    bbox_id: Uuid,
    payload: &PoiPickPayload,
    quebec_place_types: &HashMap<Uuid, String>,
) -> String {
    if let Some(place_type) = quebec_place_types.get(&bbox_id) {
        return place_type.clone();
    }
    if let Some(mut place_type) = payload.place_type.clone() {
        if place_type == "park" {
            place_type = "municipal_park".to_string();
        }
        return place_type;
    }
    payload
        .poi
        .as_ref()
        .map(|p| p.group.clone())
        .unwrap_or_default()
}

fn endpoints_match(
    a: Option<&PoiFocusMeasurement>,
    b: Option<&PoiFocusMeasurement>,
    match_radius_m: f64,
) -> Option<bool> {
    let (Some(ma), Some(mb)) = (a, b) else {
        return None;
    };
    let (Some(end_a), Some(end_b)) = (
        measurement_endpoint(&ma.coordinates),
        measurement_endpoint(&mb.coordinates),
    ) else {
        return None;
    };
    Some(haversine_distance_m(end_a[0], end_a[1], end_b[0], end_b[1]) <= match_radius_m)
}

fn abs_diff_i32(a: Option<i32>, b: Option<i32>) -> Option<i32> {
    match (a, b) {
        (Some(x), Some(y)) => Some((x - y).abs()),
        _ => None,
    }
}

/// Build one CSV row per picked POI that has a cached `poi` object.
pub fn build_poi_measurement_csv_rows(
    picks: &[(Uuid, PoiPickPayload)],
    measurements: &[PoiFocusMeasurement],
    quebec_bbox_ids: &HashSet<Uuid>,
    quebec_place_types: &HashMap<Uuid, String>,
    match_radius_m: f64,
) -> Vec<Vec<String>> {
    let mut by_bbox: HashMap<Uuid, Vec<&PoiFocusMeasurement>> = HashMap::new();
    for m in measurements {
        by_bbox.entry(m.bbox_id).or_default().push(m);
    }

    let mut rows: Vec<Vec<String>> = Vec::new();
    for (bbox_id, payload) in picks {
        let Some(poi) = payload.poi.as_ref() else {
            continue;
        };
        let bbox_measurements: Vec<&PoiFocusMeasurement> =
            by_bbox.get(bbox_id).cloned().unwrap_or_default();

        let centroid_walk = pick_centroid_to_main_walk(&bbox_measurements);
        let centroid_base = bbox_measurements
            .iter()
            .find(|m| is_centroid_entrance(m.entrance_type))
            .map(|m| centroid_base_label(m.entrance_type).to_string())
            .or_else(|| {
                centroid_walk.map(|m| centroid_base_label(m.entrance_type).to_string())
            })
            .unwrap_or_default();

        let (centroid_pt, main_pt, reversed_notes) =
            infer_common_anchors(&bbox_measurements, match_radius_m);
        let (centroid_lon, centroid_lat) = centroid_pt
            .map(|p| (p[0], p[1]))
            .unwrap_or((f64::NAN, f64::NAN));
        let (main_lon, main_lat) = main_pt
            .map(|p| (p[0], p[1]))
            .unwrap_or((f64::NAN, f64::NAN));

        let walk_centroid_to_main = centroid_walk.map(|m| m.length_m);
        let centroid_rows: Vec<&PoiFocusMeasurement> = bbox_measurements
            .iter()
            .copied()
            .filter(|m| is_centroid_entrance(m.entrance_type))
            .collect();
        let main_rows: Vec<&PoiFocusMeasurement> = bbox_measurements
            .iter()
            .copied()
            .filter(|m| m.entrance_type == EntranceKind::Main)
            .collect();
        let centroid_driving = latest_centroid_driving_measurement(&centroid_rows);
        let centroid_transit = latest_centroid_measurement(
            &centroid_rows,
            MeasurementPurpose::ToNearestTransitStop,
        );
        let main_driving =
            latest_driving_measurement(&main_rows, EntranceKind::Main);
        let main_transit = latest_measurement(
            &main_rows,
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::Main,
        );

        let euclidean = if centroid_lon.is_finite() && main_lon.is_finite() {
            Some(haversine_distance_m(centroid_lon, centroid_lat, main_lon, main_lat))
        } else {
            None
        };

        let cohort = if quebec_bbox_ids.contains(bbox_id) {
            "quebec"
        } else {
            "world"
        };

        rows.push(vec![
            format!("{}/{}", poi.osm_type.as_str(), poi.osm_id),
            format_poi_display_name(&poi.tags).unwrap_or_default(),
            centroid_base,
            if centroid_lat.is_finite() {
                format!("{centroid_lat:.7}")
            } else {
                String::new()
            },
            if centroid_lon.is_finite() {
                format!("{centroid_lon:.7}")
            } else {
                String::new()
            },
            if main_lat.is_finite() {
                format!("{main_lat:.7}")
            } else {
                String::new()
            },
            if main_lon.is_finite() {
                format!("{main_lon:.7}")
            } else {
                String::new()
            },
            resolve_category(*bbox_id, payload, quebec_place_types),
            cohort.to_string(),
            optional_i32(walk_centroid_to_main),
            optional_i32(centroid_driving.map(|m| m.length_m)),
            optional_i32(centroid_transit.map(|m| m.length_m)),
            optional_i32(main_driving.map(|m| m.length_m)),
            optional_i32(main_transit.map(|m| m.length_m)),
            optional_bool(endpoints_match(
                centroid_driving,
                main_driving,
                match_radius_m,
            )),
            optional_bool(endpoints_match(
                centroid_transit,
                main_transit,
                match_radius_m,
            )),
            optional_f64(euclidean),
            optional_i32(abs_diff_i32(
                centroid_driving.map(|m| m.length_m),
                main_driving.map(|m| m.length_m),
            )),
            optional_i32(abs_diff_i32(
                centroid_transit.map(|m| m.length_m),
                main_transit.map(|m| m.length_m),
            )),
            reversed_notes.join("; "),
        ]);
    }

    rows.sort_by(|a, b| a[0].cmp(&b[0]));
    rows
}

/// Serialize per-POI measurement rows as CSV (UTF-8, comma-separated).
pub fn format_poi_measurement_csv(
    picks: &[(Uuid, PoiPickPayload)],
    measurements: &[PoiFocusMeasurement],
    quebec_bbox_ids: &HashSet<Uuid>,
    quebec_place_types: &HashMap<Uuid, String>,
    match_radius_m: f64,
) -> String {
    let mut out = CSV_HEADERS
        .iter()
        .map(|h| csv_cell(h))
        .collect::<Vec<_>>()
        .join(",");
    out.push('\n');
    for row in build_poi_measurement_csv_rows(
        picks,
        measurements,
        quebec_bbox_ids,
        quebec_place_types,
        match_radius_m,
    ) {
        out.push_str(
            &row.iter()
                .map(|cell| csv_cell(cell))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use chrono::Utc;

    use crate::focus_measurements::MeasurementStartOrigin;
    use crate::overpass::{OsmType, Poi};

    fn poi() -> Poi {
        let mut tags = std::collections::BTreeMap::new();
        tags.insert("name".to_string(), "Test POI".to_string());
        Poi {
            osm_type: OsmType::Way,
            osm_id: 42,
            center: [-73.57, 45.5],
            tags,
            group: "shops".to_string(),
        }
    }

    fn sample(
        bbox_id: Uuid,
        purpose: MeasurementPurpose,
        entrance: EntranceKind,
        coords: Vec<[f64; 2]>,
        length_m: i32,
        created_at: chrono::DateTime<chrono::Utc>,
    ) -> PoiFocusMeasurement {
        PoiFocusMeasurement {
            id: Uuid::new_v4(),
            bbox_id,
            coordinates: coords,
            walking_speed_kmh: 5.0,
            length_m,
            measurement_type: purpose,
            entrance_type: entrance,
            start_origin: MeasurementStartOrigin::PoiFocusCentroid,
            start_osm_node_id: None,
            created_at,
        }
    }

    #[test]
    fn infer_common_anchors_uses_starts_not_destinations() {
        let bbox = Uuid::new_v4();
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let centroid_start = [-73.57, 45.5];
        let main_start = [-73.568, 45.502];
        let rows = [
            sample(
                bbox,
                MeasurementPurpose::ToNearestMainEntrance,
                EntranceKind::CentroidMainBuilding,
                vec![centroid_start, main_start],
                80,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestTransitStop,
                EntranceKind::CentroidMainBuilding,
                vec![centroid_start, [-73.56, 45.49]],
                120,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestTransitStop,
                EntranceKind::Main,
                vec![main_start, [-73.56, 45.49]],
                95,
                t0,
            ),
        ];
        let refs: Vec<&PoiFocusMeasurement> = rows.iter().collect();
        let (centroid, main, reversed) = infer_common_anchors(&refs, 10.0);
        assert_eq!(centroid, Some(centroid_start));
        assert_eq!(main, Some(main_start));
        assert!(reversed.is_empty());
    }

    #[test]
    fn infer_swaps_centroid_main_when_reference_walk_is_reversed() {
        let bbox = Uuid::new_v4();
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let centroid = [-73.57, 45.5];
        let main = [-73.568, 45.502];
        let reversed_walk = sample(
            bbox,
            MeasurementPurpose::ToNearestMainEntrance,
            EntranceKind::CentroidMainBuilding,
            vec![main, centroid],
            80,
            t0,
        );
        let walk_id = reversed_walk.id;
        let other = sample(
            bbox,
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::CentroidMainBuilding,
            vec![centroid, [-73.56, 45.49]],
            120,
            t0,
        );
        let main_row = sample(
            bbox,
            MeasurementPurpose::ToNearestTransitStop,
            EntranceKind::Main,
            vec![main, [-73.56, 45.49]],
            95,
            t0,
        );
        let rows = vec![&reversed_walk, &other, &main_row];
        let (got_centroid, got_main, notes) = infer_common_anchors(&rows, 10.0);
        assert_eq!(got_centroid, Some(centroid));
        assert_eq!(got_main, Some(main));
        assert!(notes.iter().any(|n| n.contains(&walk_id.to_string())));
    }

    #[test]
    fn csv_row_includes_distances_and_endpoint_flags() {
        let bbox = Uuid::new_v4();
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let transit_end = [-73.569, 45.501];
        let measurements = vec![
            sample(
                bbox,
                MeasurementPurpose::ToNearestMainEntrance,
                EntranceKind::CentroidMainBuilding,
                vec![[-73.57, 45.5], [-73.568, 45.502]],
                200,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestDrivingRoad,
                EntranceKind::CentroidMainBuilding,
                vec![[-73.57, 45.5], [-73.5695, 45.5005]],
                50,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestDrivingRoad,
                EntranceKind::Main,
                vec![[-73.568, 45.502], [-73.5695, 45.5005]],
                60,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestTransitStop,
                EntranceKind::CentroidMainBuilding,
                vec![[-73.57, 45.5], transit_end],
                90,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestTransitStop,
                EntranceKind::Main,
                vec![[-73.568, 45.502], transit_end],
                95,
                t0,
            ),
        ];
        let picks = vec![(
            bbox,
            PoiPickPayload {
                poi: Some(poi()),
                completed: true,
                rejected: false,
                rejected_reason: None,
                place_type: Some("shopping_center".to_string()),
            },
        )];
        let csv = format_poi_measurement_csv(
            &picks,
            &measurements,
            &HashSet::from([bbox]),
            &HashMap::from([(bbox, "shopping_center".to_string())]),
            10.0,
        );
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("osm_id,name,centroid_base"));
        assert!(lines[1].contains("way/42,Test POI,building,"));
        assert!(lines[1].contains(",200,"));
        assert!(lines[1].contains(",50,90,60,95,true,true,"));
        assert!(lines[1].contains(",10,5"));
    }

    #[test]
    fn leon_leather_fixture_exports_with_centroid_anchored_entrance_walk() {
        let bbox = Uuid::new_v4();
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let centroid_start = [-121.87161399865516, 37.32310232955082];
        let main_start = [-121.8715289, 37.323081];
        let measurements = vec![
            sample(
                bbox,
                MeasurementPurpose::ToNearestEntrance,
                EntranceKind::CentroidMainBuilding,
                vec![centroid_start, main_start],
                8,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestDrivingRoad,
                EntranceKind::CentroidMainBuilding,
                vec![centroid_start, [-121.871514, 37.322947]],
                20,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestTransitStop,
                EntranceKind::CentroidMainBuilding,
                vec![centroid_start, [-121.87226, 37.322703]],
                80,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestDrivingRoad,
                EntranceKind::Main,
                vec![main_start, [-121.871447, 37.322978]],
                14,
                t0,
            ),
            sample(
                bbox,
                MeasurementPurpose::ToNearestTransitStop,
                EntranceKind::Main,
                vec![main_start, [-121.87226, 37.322703]],
                82,
                t0,
            ),
        ];
        let picks = vec![(
            bbox,
            PoiPickPayload {
                poi: Some(poi()),
                completed: true,
                rejected: false,
                rejected_reason: None,
                place_type: None,
            },
        )];
        let row = build_poi_measurement_csv_rows(
            &picks,
            &measurements,
            &HashSet::new(),
            &HashMap::new(),
            10.0,
        )
        .pop()
        .unwrap();
        assert_eq!(row[9], "8");
        assert_eq!(row[11], "80");
        assert!(row[3].starts_with("37.32310"));
        assert!(row[5].starts_with("37.32308"));
        assert_eq!(row[2], "building");
    }

    #[test]
    fn driving_road_falls_back_to_combo_type() {
        let bbox = Uuid::new_v4();
        let t0 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let measurements = vec![sample(
            bbox,
            MeasurementPurpose::ToNearestWalkingDrivingNetwork,
            EntranceKind::CentroidMainBuilding,
            vec![[-73.57, 45.5], [-73.569, 45.501]],
            77,
            t0,
        )];
        let picks = vec![(
            bbox,
            PoiPickPayload {
                poi: Some(poi()),
                completed: false,
                rejected: false,
                rejected_reason: None,
                place_type: None,
            },
        )];
        let row = build_poi_measurement_csv_rows(
            &picks,
            &measurements,
            &HashSet::new(),
            &HashMap::new(),
            10.0,
        )
        .pop()
        .unwrap();
        assert_eq!(row[10], "77");
    }
}

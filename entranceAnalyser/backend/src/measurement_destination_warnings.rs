/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Detect when polylines aimed at the same destination type land on
//! different endpoints depending on the analyst's entrance-type anchor.
//! Mirrors `frontend/src/keptBboxes/measurementDestinationWarnings.ts`.

use std::collections::HashMap;

use geo::{Distance, Haversine, Point};
use serde::Serialize;
use uuid::Uuid;

use crate::focus_measurements::{EntranceKind, MeasurementPurpose, PoiFocusMeasurement};

/// Default when `MEASUREMENT_DESTINATION_MATCH_RADIUS_M` is unset.
pub const DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M: f64 = 10.0;

/// @deprecated Use [`DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M`].
pub const MEASUREMENT_DESTINATION_MATCH_RADIUS_M: f64 =
    DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M;

/// Destination types compared across entrance anchors (entrance targets excluded).
pub const COMPARABLE_MEASUREMENT_PURPOSES: [MeasurementPurpose; 8] = [
    MeasurementPurpose::ToNearestTransitStop,
    MeasurementPurpose::ToNearestWalkingNetwork,
    MeasurementPurpose::ToNearestCyclingNetwork,
    MeasurementPurpose::ToNearestParking,
    MeasurementPurpose::ToNearestDrivingRoad,
    MeasurementPurpose::ToNearestWalkingCyclingNetwork,
    MeasurementPurpose::ToNearestWalkingCyclingDrivingNetwork,
    MeasurementPurpose::ToNearestWalkingDrivingNetwork,
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PoiMeasurementDestinationWarnings {
    pub bbox_id: Uuid,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PoiFocusMeasurementDestinationWarningsResponse {
    /// One row per kept bbox that has at least one mismatch warning.
    pub warnings: Vec<PoiMeasurementDestinationWarnings>,
}

fn is_comparable(purpose: MeasurementPurpose) -> bool {
    COMPARABLE_MEASUREMENT_PURPOSES.contains(&purpose)
}

fn destination_warning_label(purpose: MeasurementPurpose) -> &'static str {
    match purpose {
        MeasurementPurpose::ToNearestTransitStop => "transit stop",
        MeasurementPurpose::ToNearestWalkingNetwork => "walking network",
        MeasurementPurpose::ToNearestCyclingNetwork => "cycling network",
        MeasurementPurpose::ToNearestParking => "parking",
        MeasurementPurpose::ToNearestDrivingRoad => "driving road",
        MeasurementPurpose::ToNearestWalkingCyclingNetwork => "walking + cycling network",
        MeasurementPurpose::ToNearestWalkingCyclingDrivingNetwork => {
            "walking + cycling + driving network"
        }
        MeasurementPurpose::ToNearestWalkingDrivingNetwork => "walking + driving network",
        MeasurementPurpose::ToNearestEntrance | MeasurementPurpose::ToNearestMainEntrance => {
            unreachable!("non-comparable purposes are filtered earlier")
        }
    }
}

fn entrance_warning_label(kind: EntranceKind) -> &'static str {
    match kind {
        EntranceKind::Main => "main entrance",
        EntranceKind::Customers => "customers entrance",
        EntranceKind::Home => "home entrance",
        EntranceKind::Emergency => "emergency entrance",
        EntranceKind::ServiceEmployees => "service (employees) entrance",
        EntranceKind::ServiceDelivery => "service (delivery) entrance",
        EntranceKind::Garage => "garage entrance",
        EntranceKind::CentroidMainBuilding => "main building centroid",
        EntranceKind::CentroidMultipleBuildings => "multiple-buildings centroid",
        EntranceKind::CentroidArea => "area centroid",
        EntranceKind::CentroidParcel => "parcel centroid",
        EntranceKind::Other => "other entrance",
    }
}

/// Last vertex of a saved polyline — the analyst-marked destination.
pub fn measurement_endpoint(coords: &[[f64; 2]]) -> Option<[f64; 2]> {
    coords.last().copied()
}

/// Great-circle distance between two WGS84 points in metres.
pub fn haversine_distance_m(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    Haversine.distance(Point::new(lon1, lat1), Point::new(lon2, lat2))
}

/// Human-readable warnings for every entrance-type pair whose endpoints
/// disagree on the same destination type beyond `match_radius_m`.
pub fn find_measurement_destination_mismatches(
    measurements: &[PoiFocusMeasurement],
    match_radius_m: f64,
) -> Vec<String> {
    let mut latest_by_purpose_and_entrance: HashMap<(MeasurementPurpose, EntranceKind), &PoiFocusMeasurement> =
        HashMap::new();

    for m in measurements {
        if !is_comparable(m.measurement_type) || m.coordinates.is_empty() {
            continue;
        }
        let key = (m.measurement_type, m.entrance_type);
        latest_by_purpose_and_entrance
            .entry(key)
            .and_modify(|prev| {
                if m.created_at > prev.created_at {
                    *prev = m;
                }
            })
            .or_insert(m);
    }

    let mut warnings = Vec::new();

    for purpose in COMPARABLE_MEASUREMENT_PURPOSES {
        let mut by_entrance: HashMap<EntranceKind, [f64; 2]> = HashMap::new();
        for ((p, entrance), m) in &latest_by_purpose_and_entrance {
            if *p != purpose {
                continue;
            }
            if let Some(endpoint) = measurement_endpoint(&m.coordinates) {
                by_entrance.insert(*entrance, endpoint);
            }
        }

        let mut entrance_types: Vec<EntranceKind> = by_entrance.keys().copied().collect();
        entrance_types.sort_by_key(|k| entrance_warning_label(*k));

        for i in 0..entrance_types.len() {
            for j in (i + 1)..entrance_types.len() {
                let a = entrance_types[i];
                let b = entrance_types[j];
                let end_a = by_entrance[&a];
                let end_b = by_entrance[&b];
                let dist = haversine_distance_m(end_a[0], end_a[1], end_b[0], end_b[1]);
                if dist > match_radius_m {
                    warnings.push(format!(
                        "The nearest {} is not the same for {} and {}",
                        destination_warning_label(purpose),
                        entrance_warning_label(a),
                        entrance_warning_label(b),
                    ));
                }
            }
        }
    }

    warnings
}

/// Group measurements by `bbox_id` and return only POIs with ≥1 warning.
pub fn destination_warnings_by_bbox(
    measurements: &[PoiFocusMeasurement],
    match_radius_m: f64,
) -> Vec<PoiMeasurementDestinationWarnings> {
    let mut by_bbox: HashMap<Uuid, Vec<&PoiFocusMeasurement>> = HashMap::new();
    for m in measurements {
        by_bbox.entry(m.bbox_id).or_default().push(m);
    }

    let mut out: Vec<PoiMeasurementDestinationWarnings> = by_bbox
        .into_iter()
        .filter_map(|(bbox_id, rows)| {
            let owned: Vec<PoiFocusMeasurement> = rows.into_iter().cloned().collect();
            let warnings = find_measurement_destination_mismatches(&owned, match_radius_m);
            if warnings.is_empty() {
                None
            } else {
                Some(PoiMeasurementDestinationWarnings { bbox_id, warnings })
            }
        })
        .collect();

    out.sort_by_key(|row| row.bbox_id);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sample(
        entrance_type: EntranceKind,
        coords: Vec<[f64; 2]>,
        created_at: chrono::DateTime<chrono::Utc>,
    ) -> PoiFocusMeasurement {
        PoiFocusMeasurement {
            id: Uuid::nil(),
            bbox_id: Uuid::from_u128(99),
            coordinates: coords,
            walking_speed_kmh: 5.0,
            length_m: 100,
            measurement_type: MeasurementPurpose::ToNearestTransitStop,
            entrance_type,
            start_origin: crate::focus_measurements::MeasurementStartOrigin::OsmEntrance,
            start_osm_node_id: Some(1),
            created_at,
        }
    }

    #[test]
    fn warns_when_endpoints_differ_beyond_match_radius() {
        let t0 = chrono::Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let warnings = find_measurement_destination_mismatches(
            &[
                sample(
                    EntranceKind::Main,
                    vec![[-73.57, 45.5], [-73.569, 45.501]],
                    t0,
                ),
                sample(
                    EntranceKind::CentroidMainBuilding,
                    vec![[-73.57, 45.5], [-73.56, 45.502]],
                    t0,
                ),
            ],
            MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
        );
        assert_eq!(
            warnings,
            vec![
                "The nearest transit stop is not the same for main building centroid and main entrance"
                    .to_string()
            ]
        );
    }

    #[test]
    fn does_not_warn_when_endpoints_are_within_match_radius() {
        let t0 = chrono::Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let base = [-73.569_f64, 45.501];
        let nearby = [base[0] + 0.00001, base[1] + 0.00001];
        let warnings = find_measurement_destination_mismatches(
            &[
                sample(EntranceKind::Main, vec![[-73.57, 45.5], base], t0),
                sample(
                    EntranceKind::CentroidMainBuilding,
                    vec![[-73.57, 45.5], nearby],
                    t0,
                ),
            ],
            MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn groups_warnings_by_bbox_id() {
        let t0 = chrono::Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let bbox_a = Uuid::from_u128(1);
        let bbox_b = Uuid::from_u128(2);
        let mut m_main = sample(
            EntranceKind::Main,
            vec![[-73.57, 45.5], [-73.569, 45.501]],
            t0,
        );
        m_main.bbox_id = bbox_a;
        let mut m_centroid = sample(
            EntranceKind::CentroidMainBuilding,
            vec![[-73.57, 45.5], [-73.56, 45.502]],
            t0,
        );
        m_centroid.bbox_id = bbox_a;
        let mut m_ok = sample(
            EntranceKind::Main,
            vec![[-73.57, 45.5], [-73.568, 45.5]],
            t0,
        );
        m_ok.bbox_id = bbox_b;
        m_ok.measurement_type = MeasurementPurpose::ToNearestWalkingNetwork;
        let mut m_ok2 = m_ok.clone();
        m_ok2.entrance_type = EntranceKind::CentroidMainBuilding;
        m_ok2.coordinates = vec![[-73.57, 45.5], [-73.568, 45.5]];

        let rows = destination_warnings_by_bbox(
            &[m_main, m_centroid, m_ok, m_ok2],
            MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].bbox_id, bbox_a);
        assert_eq!(rows[0].warnings.len(), 1);
    }
}

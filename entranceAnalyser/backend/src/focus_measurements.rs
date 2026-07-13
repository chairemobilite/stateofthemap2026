/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Validation and geodesic length for persisted POI-focus measure polylines.
//! Mirrors the frontend `measure.ts` speed bounds and Haversine length.
//!
//! `MeasurementPurpose`, `EntranceKind`, and `MeasurementStartOrigin` wire
//! values and Postgres CHECK constraints are defined in migrations
//! `0005_poi_focus_measurement_types.sql`,
//! `0007_poi_focus_measurement_purpose_rename.sql`,
//! `0006_poi_focus_entrance_centroid_types.sql`, and
//! `0008_poi_focus_measurement_start_origin.sql`,
//! `0009_poi_focus_measurement_type_entrance.sql`,
//! `0010_measurement_start_building_unsnapped.sql`,
//! `0013_poi_focus_measurement_type_main_entrance.sql`, mirrored in
//! `frontend/src/keptBboxes/measurementCatalog.ts` (where applicable).

use chrono::{DateTime, Utc};
use geo::{Distance, Haversine, Point};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use uuid::Uuid;

/// What the drawn polyline is measuring toward (stored snake_case in DB).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementPurpose {
    ToNearestTransitStop,
    /// Polyline toward the nearest mapped entrance (e.g. from centroid).
    ToNearestEntrance,
    /// Polyline toward the nearest entrance tagged `entrance=main` in OSM.
    ToNearestMainEntrance,
    #[serde(alias = "to_nearest_pedestrian_network")]
    ToNearestWalkingNetwork,
    ToNearestCyclingNetwork,
    ToNearestParking,
    #[serde(alias = "to_nearest_vehicle_road")]
    ToNearestDrivingRoad,
    ToNearestWalkingCyclingNetwork,
    ToNearestWalkingCyclingDrivingNetwork,
    ToNearestWalkingDrivingNetwork,
}

impl MeasurementPurpose {
    /// Wire / database value (snake_case).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ToNearestTransitStop => "to_nearest_transit_stop",
            Self::ToNearestEntrance => "to_nearest_entrance",
            Self::ToNearestMainEntrance => "to_nearest_main_entrance",
            Self::ToNearestWalkingNetwork => "to_nearest_walking_network",
            Self::ToNearestCyclingNetwork => "to_nearest_cycling_network",
            Self::ToNearestParking => "to_nearest_parking",
            Self::ToNearestDrivingRoad => "to_nearest_driving_road",
            Self::ToNearestWalkingCyclingNetwork => "to_nearest_walking_cycling_network",
            Self::ToNearestWalkingCyclingDrivingNetwork => {
                "to_nearest_walking_cycling_driving_network"
            }
            Self::ToNearestWalkingDrivingNetwork => "to_nearest_walking_driving_network",
        }
    }
}

impl fmt::Display for MeasurementPurpose {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MeasurementPurpose {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "to_nearest_transit_stop" => Ok(Self::ToNearestTransitStop),
            "to_nearest_entrance" => Ok(Self::ToNearestEntrance),
            "to_nearest_main_entrance" => Ok(Self::ToNearestMainEntrance),
            "to_nearest_walking_network" | "to_nearest_pedestrian_network" => {
                Ok(Self::ToNearestWalkingNetwork)
            }
            "to_nearest_cycling_network" => Ok(Self::ToNearestCyclingNetwork),
            "to_nearest_parking" => Ok(Self::ToNearestParking),
            "to_nearest_driving_road" | "to_nearest_vehicle_road" => Ok(Self::ToNearestDrivingRoad),
            "to_nearest_walking_cycling_network" => Ok(Self::ToNearestWalkingCyclingNetwork),
            "to_nearest_walking_cycling_driving_network" => {
                Ok(Self::ToNearestWalkingCyclingDrivingNetwork)
            }
            "to_nearest_walking_driving_network" => Ok(Self::ToNearestWalkingDrivingNetwork),
            _ => Err(()),
        }
    }
}

/// OSM-style entrance role (stored snake_case in DB).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntranceKind {
    Main,
    Customers,
    Home,
    Emergency,
    ServiceEmployees,
    ServiceDelivery,
    Garage,
    CentroidMainBuilding,
    CentroidMultipleBuildings,
    CentroidArea,
    CentroidParcel,
    Other,
}

impl EntranceKind {
    /// Wire / database value (snake_case).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Customers => "customers",
            Self::Home => "home",
            Self::Emergency => "emergency",
            Self::ServiceEmployees => "service_employees",
            Self::ServiceDelivery => "service_delivery",
            Self::Garage => "garage",
            Self::CentroidMainBuilding => "centroid_main_building",
            Self::CentroidMultipleBuildings => "centroid_multiple_buildings",
            Self::CentroidArea => "centroid_area",
            Self::CentroidParcel => "centroid_parcel",
            Self::Other => "other",
        }
    }
}

impl fmt::Display for EntranceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where the polyline’s first vertex is anchored (stored snake_case in DB).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementStartOrigin {
    /// First vertex matches the POI focus buffer centre (no OSM node id).
    PoiFocusCentroid,
    /// First vertex snapped to an OSM entrance node; `start_osm_node_id` is set.
    OsmEntrance,
    /// Rows created before `0008_poi_focus_measurement_start_origin.sql`.
    LegacyUnknown,
    /// First vertex snapped to a building polygon centroid; `start_osm_node_id` holds the OSM **way** id.
    BuildingCentroid,
    /// First vertex was not snapped to focus centre, an entrance, or a building centroid.
    UnsnappedStart,
}

impl MeasurementStartOrigin {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PoiFocusCentroid => "poi_focus_centroid",
            Self::OsmEntrance => "osm_entrance",
            Self::LegacyUnknown => "legacy_unknown",
            Self::BuildingCentroid => "building_centroid",
            Self::UnsnappedStart => "unsnapped_start",
        }
    }
}

impl fmt::Display for MeasurementStartOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MeasurementStartOrigin {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "poi_focus_centroid" => Ok(Self::PoiFocusCentroid),
            "osm_entrance" => Ok(Self::OsmEntrance),
            "legacy_unknown" => Ok(Self::LegacyUnknown),
            "building_centroid" => Ok(Self::BuildingCentroid),
            "unsnapped_start" => Ok(Self::UnsnappedStart),
            _ => Err(()),
        }
    }
}

/// Wire values accepted on `POST` / `PATCH` (never `legacy_unknown`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementStartOriginInput {
    PoiFocusCentroid,
    OsmEntrance,
    BuildingCentroid,
    UnsnappedStart,
}

impl From<MeasurementStartOriginInput> for MeasurementStartOrigin {
    fn from(v: MeasurementStartOriginInput) -> Self {
        match v {
            MeasurementStartOriginInput::PoiFocusCentroid => Self::PoiFocusCentroid,
            MeasurementStartOriginInput::OsmEntrance => Self::OsmEntrance,
            MeasurementStartOriginInput::BuildingCentroid => Self::BuildingCentroid,
            MeasurementStartOriginInput::UnsnappedStart => Self::UnsnappedStart,
        }
    }
}

/// Ensures `start_origin` / `start_osm_node_id` are mutually consistent.
pub fn validate_measurement_start_for_write(
    origin: MeasurementStartOriginInput,
    node_id: Option<i64>,
) -> Result<(), &'static str> {
    match origin {
        MeasurementStartOriginInput::PoiFocusCentroid => {
            if node_id.is_some() {
                return Err("start_osm_node_id must be null when start_origin is poi_focus_centroid");
            }
        }
        MeasurementStartOriginInput::OsmEntrance => {
            let Some(id) = node_id else {
                return Err("start_osm_node_id is required when start_origin is osm_entrance");
            };
            if id <= 0 {
                return Err("start_osm_node_id must be a positive OSM node id");
            }
        }
        MeasurementStartOriginInput::BuildingCentroid => {
            let Some(id) = node_id else {
                return Err(
                    "start_osm_node_id is required when start_origin is building_centroid (OSM way id)",
                );
            };
            if id <= 0 {
                return Err("start_osm_node_id must be a positive OSM way id for building_centroid");
            }
        }
        MeasurementStartOriginInput::UnsnappedStart => {
            if node_id.is_some() {
                return Err("start_osm_node_id must be null when start_origin is unsnapped_start");
            }
        }
    }
    Ok(())
}

impl FromStr for EntranceKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "main" => Ok(Self::Main),
            "customers" => Ok(Self::Customers),
            "home" => Ok(Self::Home),
            "emergency" => Ok(Self::Emergency),
            "service_employees" => Ok(Self::ServiceEmployees),
            "service_delivery" => Ok(Self::ServiceDelivery),
            "garage" => Ok(Self::Garage),
            "centroid_main_building" => Ok(Self::CentroidMainBuilding),
            "centroid_multiple_buildings" => Ok(Self::CentroidMultipleBuildings),
            "centroid_area" => Ok(Self::CentroidArea),
            "centroid_parcel" => Ok(Self::CentroidParcel),
            "other" => Ok(Self::Other),
            _ => Err(()),
        }
    }
}

/// Min / max / mean / median for one numeric series (length in metres or
/// duration in seconds), returned by [`crate::storage::PgStore::aggregate_poi_focus_measurement_pair_stats`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasurementFourNumberStats {
    pub min: f64,
    pub max: f64,
    pub avg: f64,
    pub median: f64,
}

/// One row of grouped statistics for a pair of categorical columns on
/// `poi_focus_measurements`. Duration uses the same model as the UI:
/// seconds $= \texttt{length\_m} \times 3600 / (1000 \times \texttt{walking\_speed\_kmh})$.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasurementPairAggregate {
    pub attr_a: String,
    pub attr_b: String,
    pub n: i64,
    pub length_m: MeasurementFourNumberStats,
    pub duration_s: MeasurementFourNumberStats,
}

/// Per-`measurement_type` statistics on the signed difference
/// (centroid − main entrance) between measurements of the same POI:
/// how much longer (or shorter) the walk is when anchored on any
/// `centroid_*` entrance kind instead of the main entrance. `n` counts
/// (main, centroid) measurement pairs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasurementDeltaAggregate {
    pub measurement_type: String,
    pub n: i64,
    pub delta_length_m: MeasurementFourNumberStats,
    pub delta_duration_s: MeasurementFourNumberStats,
}

/// One histogram bin of network walking distance. `bin_start_m` is the
/// inclusive lower bound; every bin is
/// [`CENTROID_HISTOGRAM_BIN_M`] wide except the last one
/// (`bin_start_m == CENTROID_HISTOGRAM_OVERFLOW_M`), which is
/// open-ended ("250 m and more").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeasurementHistogramBin {
    pub bin_start_m: i64,
    pub n: i64,
}

/// Width of the centroid→main-entrance histogram bins, in metres.
pub const CENTROID_HISTOGRAM_BIN_M: i64 = 25;

/// Lower bound of the open-ended last histogram bin, in metres.
pub const CENTROID_HISTOGRAM_OVERFLOW_M: i64 = 250;

/// All pairwise breakdowns exposed on `GET …/poi_focus_measurement_stats`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoiFocusMeasurementStats {
    pub by_measurement_type_and_entrance_type: Vec<MeasurementPairAggregate>,
    pub by_measurement_type_and_start_origin: Vec<MeasurementPairAggregate>,
    pub by_entrance_type_and_start_origin: Vec<MeasurementPairAggregate>,
    /// Centroid-vs-main-entrance deltas; `default` keeps older cached
    /// JSON deserialisable.
    #[serde(default)]
    pub main_entrance_vs_centroid: Vec<MeasurementDeltaAggregate>,
    /// Endpoint agreement (same/different destination point) between
    /// centroid- and main-entrance-anchored walks, per measurement type.
    #[serde(default)]
    pub main_entrance_vs_centroid_endpoints:
        Vec<crate::measurement_destination_warnings::EndpointAgreementStat>,
    /// Same as `main_entrance_vs_centroid_endpoints`, restricted to
    /// bboxes whose centre is inside the Quebec polygon (Quebec POIs
    /// are analysed separately).
    #[serde(default)]
    pub main_entrance_vs_centroid_endpoints_quebec:
        Vec<crate::measurement_destination_warnings::EndpointAgreementStat>,
    /// Histogram of the network walking distance from each aggregated
    /// centroid to the main entrance (`to_nearest_main_entrance`
    /// measurements anchored on a `centroid_*` entrance kind), in
    /// [`CENTROID_HISTOGRAM_BIN_M`]-metre bins; empty bins are omitted.
    #[serde(default)]
    pub centroid_to_main_entrance_histogram: Vec<MeasurementHistogramBin>,
    /// Same histogram, restricted to Quebec bboxes.
    #[serde(default)]
    pub centroid_to_main_entrance_histogram_quebec: Vec<MeasurementHistogramBin>,
    /// Quebec picks bucketed by place type (university, cegep,
    /// hospital, industrial, other) with centroid → main-entrance
    /// distance aggregates. Empty buckets are omitted.
    #[serde(default)]
    pub quebec_by_place_type: Vec<QuebecPlaceTypeStat>,
}

/// One Quebec place-type bucket: how many picked POIs match the
/// category's OSM tags, and the min/max/mean/median of the network
/// walking distance from the aggregated centroid to the main entrance
/// (`to_nearest_main_entrance` measurements anchored on `centroid_*`).
/// `length_m` is `None` while no such measurement exists yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuebecPlaceTypeStat {
    pub place_type: String,
    pub n_pois: i64,
    pub n_measurements: i64,
    pub length_m: Option<MeasurementFourNumberStats>,
}

/// One persisted polyline from the focus-map measurement tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoiFocusMeasurement {
    pub id: Uuid,
    pub bbox_id: Uuid,
    /// GeoJSON order: each vertex is `[lon, lat]`.
    pub coordinates: Vec<[f64; 2]>,
    pub walking_speed_kmh: f64,
    pub length_m: i32,
    pub measurement_type: MeasurementPurpose,
    pub entrance_type: EntranceKind,
    pub start_origin: MeasurementStartOrigin,
    /// OSM node id for [`MeasurementStartOrigin::OsmEntrance`], OSM **way** id for
    /// [`MeasurementStartOrigin::BuildingCentroid`]; otherwise `None`.
    pub start_osm_node_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// Request body for `POST` / `PATCH` measurement endpoints.
#[derive(Debug, Deserialize)]
pub struct PoiFocusMeasurementUpsertBody {
    pub coordinates: Vec<[f64; 2]>,
    pub walking_speed_kmh: f64,
    pub measurement_type: MeasurementPurpose,
    pub entrance_type: EntranceKind,
    pub start_origin: MeasurementStartOriginInput,
    pub start_osm_node_id: Option<i64>,
}

/// Minimum walking speed (km/h), matches frontend `MIN_WALKING_SPEED_KMH`.
pub const MIN_WALKING_SPEED_KMH: f64 = 0.5;

/// Maximum walking speed (km/h), matches frontend `MAX_WALKING_SPEED_KMH`.
pub const MAX_WALKING_SPEED_KMH: f64 = 10.0;

/// Sum of great-circle segment lengths in metres (rounded), or `None` if
/// fewer than two coordinates.
pub fn path_length_m_haversine(coords: &[[f64; 2]]) -> Option<i32> {
    if coords.len() < 2 {
        return None;
    }
    let mut total_m = 0.0_f64;
    for w in coords.windows(2) {
        let a = Point::new(w[0][0], w[0][1]);
        let b = Point::new(w[1][0], w[1][1]);
        total_m += Haversine.distance(a, b);
    }
    Some(total_m.round() as i32)
}

/// Reject empty arrays, non-finite numbers, or fewer than two vertices.
pub fn validate_coordinates(coords: &[[f64; 2]]) -> Result<(), &'static str> {
    if coords.len() < 2 {
        return Err("coordinates must contain at least two [lon, lat] points");
    }
    for c in coords {
        if !(c[0].is_finite() && c[1].is_finite()) {
            return Err("coordinates must be finite numbers");
        }
    }
    Ok(())
}

pub fn validate_walking_speed_kmh(speed: f64) -> Result<(), &'static str> {
    if !speed.is_finite() {
        return Err("walking_speed_kmh must be finite");
    }
    if !(MIN_WALKING_SPEED_KMH..=MAX_WALKING_SPEED_KMH).contains(&speed) {
        return Err("walking_speed_kmh out of allowed range");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_length_equator_segment_matches_order_of_magnitude() {
        let coords = [[0.0_f64, 0.0_f64], [0.001, 0.0]];
        let m = path_length_m_haversine(&coords).unwrap();
        assert!((m - 111).abs() <= 2, "got {m} m");
    }

    #[test]
    fn measurement_purpose_round_trips_as_str() {
        let v = MeasurementPurpose::ToNearestWalkingNetwork;
        assert_eq!(v.as_str(), "to_nearest_walking_network");
        assert_eq!(
            MeasurementPurpose::from_str(v.as_str()).unwrap(),
            v
        );
        assert_eq!(
            MeasurementPurpose::from_str("to_nearest_pedestrian_network").unwrap(),
            MeasurementPurpose::ToNearestWalkingNetwork
        );
    }

    #[test]
    fn measurement_purpose_to_nearest_entrance_round_trips() {
        let v = MeasurementPurpose::ToNearestEntrance;
        assert_eq!(v.as_str(), "to_nearest_entrance");
        assert_eq!(MeasurementPurpose::from_str(v.as_str()).unwrap(), v);
    }

    #[test]
    fn measurement_purpose_to_nearest_main_entrance_round_trips() {
        let v = MeasurementPurpose::ToNearestMainEntrance;
        assert_eq!(v.as_str(), "to_nearest_main_entrance");
        assert_eq!(MeasurementPurpose::from_str(v.as_str()).unwrap(), v);
    }

    #[test]
    fn entrance_kind_round_trips_as_str() {
        let v = EntranceKind::ServiceEmployees;
        assert_eq!(v.as_str(), "service_employees");
        assert_eq!(EntranceKind::from_str(v.as_str()).unwrap(), v);
    }

    #[test]
    fn entrance_kind_centroid_multiple_buildings_round_trips() {
        let v = EntranceKind::CentroidMultipleBuildings;
        assert_eq!(v.as_str(), "centroid_multiple_buildings");
        assert_eq!(EntranceKind::from_str(v.as_str()).unwrap(), v);
    }

    #[test]
    fn measurement_start_origin_round_trips_as_str() {
        for v in [
            MeasurementStartOrigin::OsmEntrance,
            MeasurementStartOrigin::PoiFocusCentroid,
            MeasurementStartOrigin::LegacyUnknown,
            MeasurementStartOrigin::BuildingCentroid,
            MeasurementStartOrigin::UnsnappedStart,
        ] {
            assert_eq!(MeasurementStartOrigin::from_str(v.as_str()).unwrap(), v);
        }
    }

    #[test]
    fn validate_measurement_start_for_write_centroid_rejects_node_id() {
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::PoiFocusCentroid,
            Some(1),
        )
        .is_err());
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::PoiFocusCentroid,
            None,
        )
        .is_ok());
    }

    #[test]
    fn validate_measurement_start_for_write_entrance_requires_positive_id() {
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::OsmEntrance,
            None,
        )
        .is_err());
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::OsmEntrance,
            Some(0),
        )
        .is_err());
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::OsmEntrance,
            Some(42),
        )
        .is_ok());
    }

    #[test]
    fn validate_measurement_start_for_write_building_centroid_requires_positive_way_id() {
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::BuildingCentroid,
            None,
        )
        .is_err());
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::BuildingCentroid,
            Some(0),
        )
        .is_err());
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::BuildingCentroid,
            Some(99_001),
        )
        .is_ok());
    }

    #[test]
    fn validate_measurement_start_for_write_unsnapped_rejects_node_id() {
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::UnsnappedStart,
            Some(1),
        )
        .is_err());
        assert!(validate_measurement_start_for_write(
            MeasurementStartOriginInput::UnsnappedStart,
            None,
        )
        .is_ok());
    }
}

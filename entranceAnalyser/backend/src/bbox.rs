/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Construct candidate bounding boxes from sampled population grid cells.
//!
//! All bboxes originate from the Postgres-backed GHS-POP grid (see
//! [`crate::sampler`]). For each drawn cell we walk `cell_size_km / 2`
//! kilometres north, south, east and west from the centre along great
//! circles (`geo::Haversine::destination`), giving a geodesically correct
//! `cell_size_km × cell_size_km` lat/lon-aligned rectangle at any latitude.
//!
//! The bbox carries the cell's population, density per km² and the
//! density ratio against the densest cell in the grid so the UI can show
//! "this is a 0.05× background-inhabited cell" vs. "this is a 0.97×
//! near-maximum-density urban core".

use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use geo::{Destination, Haversine, Point};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::sampler::{SampleError, SampledCell, Sampler, Strategy};

/// How this candidate bbox was produced (`kept_bboxes.candidate_source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CandidateSource {
    #[default]
    Random,
    CustomCentroid,
    /// Bbox centred on Overpass `out center` of one given node/way/relation.
    CustomOsm,
}

impl CandidateSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Random => "random",
            Self::CustomCentroid => "custom_centroid",
            Self::CustomOsm => "custom_osm",
        }
    }
}

impl fmt::Display for CandidateSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CandidateSource {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "random" => Ok(Self::Random),
            "custom_centroid" => Ok(Self::CustomCentroid),
            "custom_osm" => Ok(Self::CustomOsm),
            _ => Err(()),
        }
    }
}

/// A candidate bounding box emitted by `/api/bbox/random`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub id: Uuid,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    /// `[lon, lat]` — matches GeoJSON coordinate order.
    pub center: [f64; 2],
    /// Side length of the bbox in kilometres (matches the grid's cell size
    /// at the time it was emitted).
    pub cell_size_km: u32,
    /// Total population inside the cell, from GHS-POP.
    pub population: f64,
    /// `population / cell_size_km²`.
    pub density_per_km2: f64,
    /// `density_per_km2 / max_density_per_km2_in_grid`, in `[0, 1]`.
    pub max_density_ratio: f64,
    /// Total built volume in m³ inside the cell, from GHS-BUILT-V. Zero
    /// when the grid was built without `--built-volume`.
    #[serde(default)]
    pub built_volume: f64,
    /// `built_volume / max_built_volume_in_grid`, in `[0, 1]`. Zero when
    /// no built-volume data is available.
    #[serde(default)]
    pub max_built_volume_ratio: f64,
    /// Random grid draw vs custom lat/lon vs explicit OSM anchor; echoed on keep and stored in Postgres.
    #[serde(default)]
    pub candidate_source: CandidateSource,
    /// When [`CandidateSource::CustomOsm`], the `type/id` used to resolve the centre via Overpass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_osm_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_osm_id: Option<i64>,
}

/// A kept bbox with the acceptance timestamp, as returned by
/// `/api/bbox/kept`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeptBbox {
    #[serde(flatten)]
    pub bbox: Bbox,
    pub kept_at: DateTime<Utc>,
}

/// Build a `cell_size_km × cell_size_km` bbox centred on `(lon, lat)`.
fn rectangle_around(lon: f64, lat: f64, cell_size_km: u32) -> (f64, f64, f64, f64) {
    let half_extent_m = (cell_size_km as f64 * 1000.0) / 2.0;
    let center: Point<f64> = Point::new(lon, lat);
    let north = Haversine.destination(center, 0.0, half_extent_m);
    let south = Haversine.destination(center, 180.0, half_extent_m);
    let east = Haversine.destination(center, 90.0, half_extent_m);
    let west = Haversine.destination(center, 270.0, half_extent_m);
    (west.x(), south.y(), east.x(), north.y())
}

/// Build a `Bbox` from a sampled grid cell. Fresh v4 UUID per call.
pub fn bbox_from_cell(
    sampled: SampledCell,
    cell_size_km: u32,
    candidate_source: CandidateSource,
) -> Bbox {
    let (west, south, east, north) = rectangle_around(sampled.lon, sampled.lat, cell_size_km);
    Bbox {
        id: Uuid::new_v4(),
        west,
        south,
        east,
        north,
        center: [sampled.lon, sampled.lat],
        cell_size_km,
        population: sampled.pop,
        density_per_km2: sampled.density_per_km2,
        max_density_ratio: sampled.max_density_ratio,
        built_volume: sampled.built_volume,
        max_built_volume_ratio: sampled.max_built_volume_ratio,
        candidate_source,
        custom_osm_type: None,
        custom_osm_id: None,
    }
}

/// Convenience: draw a cell from `sampler` under `strategy` and turn it
/// into a `Bbox`.
pub async fn random_bbox(sampler: &Sampler, strategy: Strategy) -> Result<Bbox, SampleError> {
    let cell = sampler.sample(strategy).await?;
    Ok(bbox_from_cell(
        cell,
        sampler.cell_size_km(),
        CandidateSource::Random,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use geo::{Distance, Haversine, Point};
    use rstest::rstest;

    fn cell_at(lat: f64, lon: f64, cell_size_km: u32) -> SampledCell {
        Sampler::decorate_for_tests(cell_size_km, 10.0, lat, lon, 1000.0)
    }

    #[rstest]
    #[case(1, 0.0)]
    #[case(5, 30.0)]
    #[case(10, -45.0)]
    #[case(25, 60.0)]
    fn bbox_side_matches_cell_size(#[case] cell_size_km: u32, #[case] lat: f64) {
        let b = bbox_from_cell(
            cell_at(lat, 0.0, cell_size_km),
            cell_size_km,
            CandidateSource::Random,
        );
        let width = Haversine.distance(Point::new(b.west, lat), Point::new(b.east, lat));
        let height = Haversine.distance(Point::new(0.0, b.south), Point::new(0.0, b.north));
        let expected = cell_size_km as f64 * 1000.0;
        assert!((width - expected).abs() < 5.0, "width = {width:.1} m");
        assert!((height - expected).abs() < 5.0, "height = {height:.1} m");
        assert_eq!(b.cell_size_km, cell_size_km);
    }

    #[test]
    fn population_density_and_ratio_are_propagated() {
        // 1000 people in a 10 × 10 km cell ⇒ 10 / km². Max density set
        // to 10 / km² via the helper so ratio = 1.0.
        let cell = Sampler::decorate_for_tests(10, 10.0, 0.0, 0.0, 1000.0);
        let b = bbox_from_cell(cell, 10, CandidateSource::Random);
        assert_eq!(b.population, 1000.0);
        assert!((b.density_per_km2 - 10.0).abs() < 1e-9);
        assert!((b.max_density_ratio - 1.0).abs() < 1e-9);
    }

    #[test]
    fn built_volume_is_propagated() {
        let cell = Sampler::decorate_for_tests_full(10, 10.0, 2000.0, 0.0, 0.0, 1000.0, 500.0);
        let b = bbox_from_cell(cell, 10, CandidateSource::Random);
        assert_eq!(b.built_volume, 500.0);
        assert!((b.max_built_volume_ratio - 0.25).abs() < 1e-9);
    }

    #[test]
    fn each_call_yields_a_fresh_uuid() {
        let cell = cell_at(0.0, 0.0, 10);
        let a = bbox_from_cell(cell, 10, CandidateSource::Random);
        let b = bbox_from_cell(cell, 10, CandidateSource::Random);
        assert_ne!(a.id, b.id);
    }
}

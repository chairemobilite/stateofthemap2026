//! Construct candidate bounding boxes from sampled population grid cells.
//!
//! All bboxes now originate from the pre-computed GHS-POP grid (see
//! [`crate::sampler`]). For each drawn cell we walk `cell_size_km / 2`
//! kilometres north, south, east and west from the centre along great
//! circles (`geo::Haversine::destination`), giving a geodesically correct
//! `cell_size_km × cell_size_km` lat/lon-aligned rectangle at any latitude.
//!
//! The bbox carries the cell's population, density per km² and the
//! density ratio against the densest cell in the grid so the UI can show
//! "this is a 0.05× background-inhabited cell" vs. "this is a 0.97×
//! near-maximum-density urban core".

use chrono::{DateTime, Utc};
use geo::{Destination, Haversine, Point};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::sampler::{SampledCell, Sampler};

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
}

/// A kept bbox persisted to `kept_bboxes.json`, with an acceptance timestamp.
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
pub fn bbox_from_cell(sampled: SampledCell, cell_size_km: u32) -> Bbox {
    let lon = sampled.cell.lon as f64;
    let lat = sampled.cell.lat as f64;
    let (west, south, east, north) = rectangle_around(lon, lat, cell_size_km);
    Bbox {
        id: Uuid::new_v4(),
        west,
        south,
        east,
        north,
        center: [lon, lat],
        cell_size_km,
        population: sampled.cell.pop as f64,
        density_per_km2: sampled.density_per_km2,
        max_density_ratio: sampled.max_density_ratio,
    }
}

/// Convenience: draw a cell from `sampler` and turn it into a `Bbox`.
pub fn random_bbox(sampler: &Sampler) -> Bbox {
    bbox_from_cell(sampler.sample(), sampler.cell_size_km())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::{Cell, GridFile};
    use geo::{Distance, Haversine, Point};
    use rstest::rstest;

    fn one_cell_sampler(lat: f32, lon: f32, pop: f32, cell_size_km: u32) -> Sampler {
        Sampler::new(GridFile::new(
            cell_size_km,
            2020,
            vec![Cell { lat, lon, pop }],
        ))
        .unwrap()
    }

    #[rstest]
    #[case(1, 0.0)]
    #[case(5, 30.0)]
    #[case(10, -45.0)]
    #[case(25, 60.0)]
    fn bbox_side_matches_cell_size(#[case] cell_size_km: u32, #[case] lat: f64) {
        let sampler = one_cell_sampler(lat as f32, 0.0, 1000.0, cell_size_km);
        let b = random_bbox(&sampler);
        let width = Haversine.distance(Point::new(b.west, lat), Point::new(b.east, lat));
        let height = Haversine.distance(Point::new(0.0, b.south), Point::new(0.0, b.north));
        let expected = cell_size_km as f64 * 1000.0;
        assert!((width - expected).abs() < 5.0, "width = {width:.1} m");
        assert!((height - expected).abs() < 5.0, "height = {height:.1} m");
        assert_eq!(b.cell_size_km, cell_size_km);
    }

    #[test]
    fn population_density_and_ratio_are_propagated() {
        let sampler = one_cell_sampler(0.0, 0.0, 1000.0, 10);
        let b = random_bbox(&sampler);
        assert_eq!(b.population, 1000.0);
        assert!((b.density_per_km2 - 10.0).abs() < 1e-9); // 1000 / (10 km)²
        assert!((b.max_density_ratio - 1.0).abs() < 1e-9);
    }

    #[test]
    fn each_call_yields_a_fresh_uuid() {
        let sampler = one_cell_sampler(0.0, 0.0, 1.0, 10);
        let a = random_bbox(&sampler);
        let b = random_bbox(&sampler);
        assert_ne!(a.id, b.id);
    }
}

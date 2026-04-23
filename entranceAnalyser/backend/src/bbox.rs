//! Random 10 × 10 km bounding box generation.
//!
//! A bbox is sampled uniformly in (lat, lon) space within `[-85°, 85°]` in
//! latitude and `[-180°, 180°]` in longitude. This oversamples the poles on
//! purpose for the MVP — the downstream GHS-POP filter and human review
//! compensate for the bias.
//!
//! Future improvement: sample uniformly on the sphere via
//! `lat = asin(uniform(-1, 1))`.
//!
//! Corners are computed with `geo::Haversine::destination` so the 10 × 10 km
//! extent is geodesically accurate at any latitude instead of relying on a
//! flat-earth `1 / cos(lat)` approximation.

use chrono::{DateTime, Utc};
use geo::{Destination, Haversine, Point};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Half-extent of the bbox in metres. 5 km north-south and east-west gives a
/// 10 × 10 km box.
const HALF_EXTENT_M: f64 = 5_000.0;
/// Latitude cap. Beyond ±85° Web Mercator breaks down and MapLibre cannot
/// render tiles cleanly, so we do not sample there.
const LAT_LIMIT_DEG: f64 = 85.0;

/// A candidate bounding box emitted by the `/api/bbox/random` endpoint.
///
/// The `population` and `filtered` fields are populated in PR 5 when the
/// GHS-POP pre-filter lands; until then they are `None` / `false`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub id: Uuid,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    /// `[lon, lat]` — matches GeoJSON coordinate order.
    pub center: [f64; 2],
    pub population: Option<u64>,
    pub filtered: bool,
}

/// A kept bbox persisted to `kept_bboxes.json`, with an acceptance timestamp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeptBbox {
    #[serde(flatten)]
    pub bbox: Bbox,
    pub kept_at: DateTime<Utc>,
}

/// Build a 10 × 10 km bbox centred on `(lon, lat)` with a fresh v4 UUID.
///
/// Corners are obtained by walking 5 km north, south, east and west from the
/// centre along great circles (`geo::Haversine::destination`), then assembling
/// a lat/lon-aligned rectangle. This gives a geodesically correct 10 × 10 km
/// box at any latitude the function is valid for.
pub fn bbox_from_center(lon: f64, lat: f64) -> Bbox {
    let center: Point<f64> = Point::new(lon, lat);
    let north = Haversine.destination(center, 0.0, HALF_EXTENT_M);
    let south = Haversine.destination(center, 180.0, HALF_EXTENT_M);
    let east = Haversine.destination(center, 90.0, HALF_EXTENT_M);
    let west = Haversine.destination(center, 270.0, HALF_EXTENT_M);
    Bbox {
        id: Uuid::new_v4(),
        west: west.x(),
        south: south.y(),
        east: east.x(),
        north: north.y(),
        center: [lon, lat],
        population: None,
        filtered: false,
    }
}

/// Draw a random 10 × 10 km bbox anywhere on Earth (within the latitude cap).
pub fn random_bbox() -> Bbox {
    let mut rng = rand::rng();
    let lat = rng.random_range(-LAT_LIMIT_DEG..LAT_LIMIT_DEG);
    // Shrink the longitude range symmetrically so the bbox never crosses the
    // antimeridian. At lat = ±85° the half-width is about 0.52° so a 2°
    // safety margin is plenty at every valid latitude.
    let lon = rng.random_range(-178.0..178.0);
    bbox_from_center(lon, lat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use geo::{Distance, Haversine, Point};
    use rstest::rstest;

    #[rstest]
    #[case(0.0)]
    #[case(30.0)]
    #[case(-30.0)]
    #[case(60.0)]
    #[case(-60.0)]
    #[case(84.0)]
    #[case(-84.0)]
    fn bbox_is_close_to_10_km_wide_and_tall(#[case] lat: f64) {
        let bbox = bbox_from_center(0.0, lat);
        let width = Haversine.distance(
            Point::new(bbox.west, lat),
            Point::new(bbox.east, lat),
        );
        let height = Haversine.distance(
            Point::new(0.0, bbox.south),
            Point::new(0.0, bbox.north),
        );
        let expected = 2.0 * HALF_EXTENT_M;
        assert!(
            (width - expected).abs() < 2.0,
            "width = {width:.2} m at lat = {lat}°, expected {expected:.0} m",
        );
        assert!(
            (height - expected).abs() < 2.0,
            "height = {height:.2} m at lat = {lat}°, expected {expected:.0} m",
        );
    }

    #[test]
    fn random_bbox_stays_within_bounds_and_has_null_population() {
        for _ in 0..200 {
            let b = random_bbox();
            assert!(b.center[1].abs() <= LAT_LIMIT_DEG);
            assert!(b.west >= -180.0 && b.east <= 180.0);
            assert!(b.west < b.east && b.south < b.north);
            assert!(b.population.is_none());
            assert!(!b.filtered);
        }
    }
}

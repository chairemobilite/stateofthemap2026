/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Inverse Mollweide projection (EPSG:54009 → WGS84).
//!
//! GHS-POP is published on a Mollweide grid centred on the prime meridian and
//! built on the WGS84 sphere of radius `R = 6 378 137 m`. We need the inverse
//! transform to know where each aggregated population cell sits in
//! `(lat, lon)` space so the runtime can build a haversine bbox around it.
//!
//! Forward formula (for reference):
//! ```text
//!   2θ + sin(2θ)  = π · sin(φ)
//!   x             = (2√2 / π) · R · (λ − λ₀) · cos(θ)
//!   y             = √2 · R · sin(θ)
//! ```
//!
//! Inverse:
//! ```text
//!   θ   = asin( y / (R · √2) )
//!   φ   = asin( (2θ + sin(2θ)) / π )
//!   λ   = λ₀ + π · x / (2 · √2 · R · cos(θ))
//! ```
//!
//! At ±90° latitude the inverse for `λ` is undefined (cos(θ) → 0); the cells
//! GHS-POP actually publishes never reach the singularity (no population at
//! the poles), so we just clamp the input to the legal Mollweide ellipse.

use std::f64::consts::{PI, SQRT_2};

/// Sphere radius used by EPSG:54009 (WGS84 semi-major axis).
const R: f64 = 6_378_137.0;

/// Mollweide ellipse half-height: `√2 · R`. Used to clamp the input `y`
/// before `asin()` to avoid NaN at the singularity.
const HALF_HEIGHT_M: f64 = SQRT_2 * R;

/// Inverse Mollweide projection.
///
/// `x` and `y` are in metres in EPSG:54009 (`x` east-positive, `y`
/// north-positive). The returned tuple is `(latitude, longitude)` in degrees.
///
/// Inputs outside the valid Mollweide ellipse are clamped to it before the
/// inverse formula is applied.
pub fn inverse(x_m: f64, y_m: f64) -> (f64, f64) {
    // Clamp to the Mollweide ellipse so asin() never sees |arg| > 1.
    let y = y_m.clamp(-HALF_HEIGHT_M, HALF_HEIGHT_M);
    let theta = (y / (SQRT_2 * R)).asin();
    let lat = ((2.0 * theta + (2.0 * theta).sin()) / PI).asin();
    let cos_theta = theta.cos();
    let lon = if cos_theta.abs() < 1e-12 {
        // Pole — longitude undefined; return 0 by convention.
        0.0
    } else {
        PI * x_m / (2.0 * SQRT_2 * R * cos_theta)
    };
    (lat.to_degrees(), lon.to_degrees())
}

/// Forward Mollweide projection — only used by the unit tests to verify the
/// inverse round-trips. Newton iteration on `2θ + sin(2θ) = π sin(φ)`.
#[cfg(test)]
pub(crate) fn forward(lat_deg: f64, lon_deg: f64) -> (f64, f64) {
    let lat = lat_deg.to_radians();
    let lon = lon_deg.to_radians();
    let mut theta = lat;
    for _ in 0..10 {
        let f = 2.0 * theta + (2.0 * theta).sin() - PI * lat.sin();
        let fp = 2.0 + 2.0 * (2.0 * theta).cos();
        theta -= f / fp;
    }
    let x = (2.0 * SQRT_2 / PI) * R * lon * theta.cos();
    let y = SQRT_2 * R * theta.sin();
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[test]
    fn origin_maps_to_lat_lon_zero() {
        let (lat, lon) = inverse(0.0, 0.0);
        assert!(lat.abs() < 1e-9, "lat = {lat}");
        assert!(lon.abs() < 1e-9, "lon = {lon}");
    }

    #[rstest]
    #[case(0.0, 0.0)]
    #[case(45.0, 30.0)]
    #[case(-45.0, -120.0)]
    #[case(60.0, 90.0)]
    #[case(-60.0, -90.0)]
    #[case(80.0, 175.0)]
    #[case(-80.0, -175.0)]
    fn forward_then_inverse_round_trips(#[case] lat_deg: f64, #[case] lon_deg: f64) {
        let (x, y) = forward(lat_deg, lon_deg);
        let (lat_back, lon_back) = inverse(x, y);
        assert!(
            (lat_back - lat_deg).abs() < 1e-6,
            "lat round-trip: {lat_deg} → {lat_back}",
        );
        assert!(
            (lon_back - lon_deg).abs() < 1e-6,
            "lon round-trip: {lon_deg} → {lon_back}",
        );
    }

    #[test]
    fn pole_y_is_clamped() {
        let (lat, _) = inverse(0.0, HALF_HEIGHT_M * 1.5);
        assert!((lat - 90.0).abs() < 1e-6, "lat = {lat}");
    }
}

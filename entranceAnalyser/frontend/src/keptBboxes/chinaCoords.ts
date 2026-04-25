//! WGS84 ↔ GCJ-02 ↔ BD09 coordinate conversions.
//!
//! Required because:
//! - OSM (and our backend) store everything in WGS84.
//! - Chinese law mandates that consumer maps publish *only* GCJ-02
//!   coordinates (the so-called "Mars datum"), a deliberate
//!   non-linear offset of WGS84. AMap, Tencent, Apple Maps in China,
//!   and any 天地图-derived basemap render on GCJ-02.
//! - Baidu Maps adds a second, different obfuscation on top of
//!   GCJ-02, called BD09.
//!
//! The offset is not constant — roughly 50 m in the southeast coast,
//! up to 700 m in Xinjiang. Linking a WGS84 lat/lon directly into a
//! Chinese map service plants the marker on the wrong block.
//!
//! Algorithms are the standard public ones used by every Chinese
//! mapping client (the canonical reference is the open-source
//! `coordtransform` Python/JS package). All functions are pure: no
//! DOM, no `fetch`, fully unit-testable.
//!
//! Conversions are *not* exact inverses (the GCJ-02 transform is
//! one-way by design), so we only provide WGS84 → GCJ-02 → BD09 in
//! this file. Reverse conversions are not needed for the right-click
//! menu and would only invite confusion.

/** Krasovsky 1940 ellipsoid semi-major axis (m), used by GCJ-02. */
const A = 6378245.0;

/** Krasovsky 1940 first eccentricity squared. */
const EE = 0.006_693_421_622_965_943;

/** π / 180 — degrees to radians, baked in for the polynomial fits. */
const PI_DEG = Math.PI;

/**
 * China-bounding-box check from the canonical `coordtransform`
 * implementation. When a point is outside this loose box the GCJ-02
 * offset is defined as zero, so WGS84 coordinates pass through
 * unchanged. The box is intentionally wider than mainland China —
 * Hainan and parts of Xinjiang sit near the edges — to keep the
 * boundary safe rather than tight.
 *
 * @param lat - latitude in WGS84 degrees
 * @param lon - longitude in WGS84 degrees
 * @returns `true` when the point is *outside* the conversion zone.
 */
export function outOfChina(lat: number, lon: number): boolean {
    return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

/** Latitude polynomial fit used by GCJ-02. */
function transformLat(x: number, y: number): number {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI_DEG) + 20.0 * Math.sin(2.0 * x * PI_DEG)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * PI_DEG) + 40.0 * Math.sin((y / 3.0) * PI_DEG)) * 2.0) / 3.0;
    ret +=
        ((160.0 * Math.sin((y / 12.0) * PI_DEG) + 320 * Math.sin((y * PI_DEG) / 30.0)) * 2.0) / 3.0;
    return ret;
}

/** Longitude polynomial fit used by GCJ-02. */
function transformLon(x: number, y: number): number {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * PI_DEG) + 20.0 * Math.sin(2.0 * x * PI_DEG)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * PI_DEG) + 40.0 * Math.sin((x / 3.0) * PI_DEG)) * 2.0) / 3.0;
    ret +=
        ((150.0 * Math.sin((x / 12.0) * PI_DEG) + 300.0 * Math.sin((x / 30.0) * PI_DEG)) * 2.0) /
        3.0;
    return ret;
}

/** A `[lat, lon]` pair in some datum; the function name says which. */
export type LatLon = readonly [lat: number, lon: number];

/**
 * Convert a WGS84 coordinate to GCJ-02 ("Mars datum"), the input
 * format expected by AMap, Tencent Maps, and Apple Maps in China.
 * Returns the input unchanged when the point lies outside mainland
 * China (per [`outOfChina`]).
 */
export function wgs84ToGcj02(lat: number, lon: number): LatLon {
    if (outOfChina(lat, lon)) return [lat, lon];
    const dLatRaw = transformLat(lon - 105.0, lat - 35.0);
    const dLonRaw = transformLon(lon - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI_DEG;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const dLat = (dLatRaw * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI_DEG);
    const dLon = (dLonRaw * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI_DEG);
    return [lat + dLat, lon + dLon];
}

/**
 * Convert a GCJ-02 coordinate to BD09, the format expected by Baidu
 * Maps. The transform is well-defined everywhere on Earth (no
 * out-of-China shortcut), so this is a pure analytic step.
 */
export function gcj02ToBd09(lat: number, lon: number): LatLon {
    const z =
        Math.sqrt(lon * lon + lat * lat) + 0.000_02 * Math.sin((lat * PI_DEG * 3000.0) / 180.0);
    const theta = Math.atan2(lat, lon) + 0.000_003 * Math.cos((lon * PI_DEG * 3000.0) / 180.0);
    return [z * Math.sin(theta) + 0.006, z * Math.cos(theta) + 0.0065];
}

/**
 * Convert a WGS84 coordinate directly to BD09, by chaining the two
 * transforms above. Returns the input unchanged outside mainland
 * China — Baidu Maps is keyed on BD09 globally, but for points
 * outside the GCJ-02 zone the GCJ-02 step is identity, so only the
 * (small but globally defined) GCJ-02 → BD09 step actually runs.
 */
export function wgs84ToBd09(lat: number, lon: number): LatLon {
    const [gLat, gLon] = wgs84ToGcj02(lat, lon);
    return gcj02ToBd09(gLat, gLon);
}

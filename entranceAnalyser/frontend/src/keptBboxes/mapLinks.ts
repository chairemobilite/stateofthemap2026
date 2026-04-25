//! Pure URL builders for the map's right-click "open in …" menu.
//!
//! All helpers take the click position (`lat`, `lon`, `zoom`) and
//! return a fully-formed URL string. They do not perform any I/O, so
//! every branch is unit-testable without a DOM or `window`.
//!
//! Coordinate values are passed through with their full floating-point
//! precision. Service viewers happily accept long decimals, and
//! truncating client-side would silently move the click target. The
//! `zoom` placeholder is floored before substitution because every
//! viewer here expects an integer zoom in its URL.

/** Coordinates of a click on the focus map. `lon` is *east* (matches
 *  MapLibre's `[lon, lat]` convention); `zoom` is the current map
 *  zoom (typically a non-integer in MapLibre, floored at link time). */
export interface MapPoint {
    lat: number;
    lon: number;
    zoom: number;
}

/** Round `zoom` toward zero — every viewer URL we link to expects
 *  an integer in its hash/query, and floating zooms render as
 *  `17.5234` which a few viewers reject outright. */
function intZoom(zoom: number): number {
    return Math.floor(zoom);
}

/**
 * Mapillary web app, deeplinked to the click position. The viewer
 * automatically opens the closest available image when the user
 * clicks the highlighted dot.
 *
 * Mapillary uses `lng` (not `lon`) and floats are accepted at full
 * precision.
 */
export function mapillaryUrl({ lat, lon, zoom }: MapPoint): string {
    return `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=${intZoom(zoom)}`;
}

/**
 * Panoramax (OSM-France instance). The viewer uses MapLibre's hash
 * format (`#map=zoom/lat/lon`) for the map position; the global
 * federation portal at `api.panoramax.xyz` accepts the same hash but
 * the OSM-FR mirror is the more relevant default for this project.
 */
export function panoramaxUrl({ lat, lon, zoom }: MapPoint): string {
    return `https://panoramax.openstreetmap.fr/#map=${intZoom(zoom)}/${lat}/${lon}`;
}

/**
 * KartaView (formerly OpenStreetView). The map page uses the
 * `@lat,lon,zoomz` suffix on `/map`, mirroring the iD/RapiD style
 * permalinks.
 */
export function kartaViewUrl({ lat, lon, zoom }: MapPoint): string {
    return `https://kartaview.org/map/@${lat},${lon},${intZoom(zoom)}z`;
}

/**
 * Google Street View, via the public Maps URL API. The
 * `map_action=pano` action requests Street View at `viewpoint`;
 * Google falls back to the regular map when no panorama exists at
 * the viewpoint, so the link is safe to open even off-coverage.
 *
 * The Maps URL API does not accept a zoom parameter for pano
 * actions, so `zoom` is ignored here.
 */
export function googleStreetViewUrl({ lat, lon }: MapPoint): string {
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`;
}

/**
 * OSM editor URL built from the backend-managed template.
 * `{lat}` / `{lon}` / `{zoom}` placeholders are substituted with the
 * click position. The template itself is fetched from
 * `GET /api/config` so operators can swap the iD permalink for a
 * self-hosted editor / RapiD / JOSM remote-control endpoint without
 * a frontend rebuild.
 *
 * @param template - URL with `{lat}` / `{lon}` / `{zoom}` placeholders.
 * @param point    - Click position; `zoom` is floored to an integer
 *                   to match the iD permalink convention.
 */
export function osmEditorUrl(template: string, { lat, lon, zoom }: MapPoint): string {
    return template
        .replaceAll('{lat}', String(lat))
        .replaceAll('{lon}', String(lon))
        .replaceAll('{zoom}', String(intZoom(zoom)));
}

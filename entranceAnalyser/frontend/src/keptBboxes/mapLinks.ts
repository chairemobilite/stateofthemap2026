/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

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
//!
//! The Chinese services (Baidu, AMap) require client-side datum
//! conversion before linking — see `chinaCoords.ts`.

import { wgs84ToBd09, wgs84ToGcj02 } from './chinaCoords';

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

/** Default zoom for iD/OSM editor permalinks — matches the backend
 *  `DEFAULT_OSM_EDITOR_URL` and iD's comfortable level for entrances. */
export const OSM_EDITOR_DEFAULT_ZOOM = 20;

/**
 * `zoom/lat/lon` segment for iD and osm.org editor URLs (`#map=…`).
 * Zoom is fixed at {@link OSM_EDITOR_DEFAULT_ZOOM} so the fragment can
 * be pasted straight after `#map=` in any editor permalink.
 */
export function osmEditorMapSegment({ lat, lon }: Pick<MapPoint, 'lat' | 'lon'>): string {
    return `${OSM_EDITOR_DEFAULT_ZOOM}/${lat}/${lon}`;
}

/**
 * Mapillary web app, deeplinked to the click position. The viewer
 * lands at `lat/lng/z` and renders coverage dots; the user picks the
 * dot they want to inspect.
 *
 * We can't deeplink straight into the photo viewer without a `pKey`
 * (image id), which would require a Graph-API lookup with an access
 * token. Until we have one, "land at the map and click the dot" is
 * the honest UX.
 *
 * Mapillary uses `lng` (not `lon`) and accepts floats at full precision.
 */
export function mapillaryUrl({ lat, lon, zoom }: MapPoint): string {
    return `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=${intZoom(zoom)}`;
}

/**
 * Panoramax (OSM-France instance). The Panoramax SPA reads its map
 * state from the *query string*, not the URL hash — passing
 * `#map=…` lands on the marketing landing page because the SPA
 * never sees the parameters. We use `?focus=map&map=zoom/lat/lon`
 * to match the format the viewer itself emits.
 *
 * Like Mapillary, true pano-viewer deeplinks need a `pic=<uuid>`
 * parameter, which we don't have without a separate API call.
 */
export function panoramaxUrl({ lat, lon, zoom }: MapPoint): string {
    // Panoramax emits unencoded slashes in `map=zoom/lat/lon` — match
    // its own format verbatim rather than letting URLSearchParams
    // percent-encode them, even though both forms parse identically.
    return `https://panoramax.openstreetmap.fr/?focus=map&map=${intZoom(zoom)}/${lat}/${lon}`;
}

/**
 * KartaView (formerly OpenStreetView). The map page uses the
 * `@lat,lon,zoomz` suffix on `/map`, mirroring the iD/RapiD style
 * permalinks. The viewer renders coverage tracks and lets the user
 * click into the photo viewer.
 *
 * KartaView's photo viewer lives at `/details/<sequence>/<photo>`
 * and there is no documented URL parameter to auto-open the closest
 * photo from a lat/lon — we'd need an API lookup, same as Mapillary.
 * Without that, opening the map at the location is the best we can
 * do; off-coverage clicks just show an empty map.
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
 * Baidu Maps, deeplinked to the click position. Baidu has by far
 * the largest street-level imagery coverage in mainland China; the
 * marker URL opens the web map at the BD09 lat/lon and lets the
 * user toggle into 全景 (panorama / street view) from there.
 *
 * The input is converted from WGS84 to BD09 client-side because
 * Baidu's web marker endpoint does not reliably honour
 * `coord_type=wgs84` (only the official `baidumap://` URI scheme
 * does). Doing the conversion ourselves guarantees the marker lands
 * on the correct building rather than ~50–700 m off, which is the
 * whole point of having this menu item.
 */
export function baiduPanoramaUrl({ lat, lon }: MapPoint): string {
    const [bdLat, bdLon] = wgs84ToBd09(lat, lon);
    const params = new URLSearchParams({
        location: `${bdLat},${bdLon}`,
        title: 'OSM sample',
        content: 'OSM sample',
        output: 'html',
        coord_type: 'bd09ll',
        src: 'entrance-analyser',
    });
    return `https://api.map.baidu.com/marker?${params}`;
}

/**
 * AMap (高德地图), the dominant alternative to Baidu in China.
 * Coverage of street-level imagery is strong in tier-1 and tier-2
 * cities and the URI-share endpoint is documented and stable.
 *
 * The input is converted from WGS84 to GCJ-02 client-side. AMap
 * does accept `coordinate=wgs84` server-side per their public docs,
 * but doing the conversion ourselves keeps the deeplink behaviour
 * symmetric with Baidu's and decoupled from any AMap server
 * regression.
 *
 * Note the swapped order: AMap uses `position=lng,lat` (lng first).
 */
export function amapUrl({ lat, lon }: MapPoint): string {
    const [gcjLat, gcjLon] = wgs84ToGcj02(lat, lon);
    const params = new URLSearchParams({
        position: `${gcjLon},${gcjLat}`,
        name: 'OSM sample',
        src: 'entrance-analyser',
        coordinate: 'gaode',
        callnative: '0',
    });
    return `https://uri.amap.com/marker?${params}`;
}

/**
 * OSM editor URL built from the backend-managed template.
 * `{lat}` / `{lon}` are substituted with the click position; `{zoom}`
 * is always {@link OSM_EDITOR_DEFAULT_ZOOM} so the editor opens at
 * entrance-editing level regardless of the focus map's current zoom.
 * The template itself is fetched from `GET /api/config` so operators
 * can swap the iD permalink for a self-hosted editor / RapiD / JOSM
 * remote-control endpoint without a frontend rebuild.
 *
 * @param template - URL with `{lat}` / `{lon}` / `{zoom}` placeholders.
 * @param point    - Click position (`lat` / `lon` only; map zoom is ignored).
 */
export function osmEditorUrl(template: string, { lat, lon }: Pick<MapPoint, 'lat' | 'lon'>): string {
    return template
        .replaceAll('{lat}', String(lat))
        .replaceAll('{lon}', String(lon))
        .replaceAll('{zoom}', String(OSM_EDITOR_DEFAULT_ZOOM));
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Basemap catalogue for the Entrance Analyser map view.
//!
//! Each entry is a full MapLibre `StyleSpecification` so switching basemap
//! is just `map.setStyle(basemap.style)` — no mutation of sources/layers
//! from the component.
//!
//! Only OSM and ESRI World Imagery are shipped in this PR. Bing Aerial is
//! planned but needs a metadata roundtrip (`dev.virtualearth.net/.../Metadata/Aerial`)
//! to obtain the tile URL template and quadkey expansion — it will land in
//! a follow-up alongside the `VITE_BING_API_KEY` env var.

import type { StyleSpecification } from 'maplibre-gl';

export type BasemapId = 'osm' | 'esri-imagery';

export interface Basemap {
    id: BasemapId;
    label: string;
    style: StyleSpecification;
}

/**
 * Build a MapLibre style containing a single raster source and the layer
 * that renders it. Kept private; every basemap in this file is raster.
 *
 * @param id           basemap id, reused as the source/layer name
 * @param tileUrl      tile URL template with `{z}/{x}/{y}` placeholders
 * @param attribution  attribution string shown in the map controls
 * @param maxZoom      maximum zoom served by the tile provider
 */
function rasterStyle(
    id: string,
    tileUrl: string,
    attribution: string,
    maxZoom: number,
): StyleSpecification {
    return {
        version: 8,
        sources: {
            [id]: {
                type: 'raster',
                tiles: [tileUrl],
                tileSize: 256,
                attribution,
                maxzoom: maxZoom,
            },
        },
        layers: [
            {
                id,
                type: 'raster',
                source: id,
            },
        ],
    };
}

export const BASEMAPS: Basemap[] = [
    {
        id: 'osm',
        label: 'OSM',
        style: rasterStyle(
            'osm',
            'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            '© OpenStreetMap contributors',
            19,
        ),
    },
    {
        id: 'esri-imagery',
        label: 'Aerial (ESRI)',
        style: rasterStyle(
            'esri-imagery',
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            'Imagery © Esri, Maxar, Earthstar Geographics',
            19,
        ),
    },
];

export const DEFAULT_BASEMAP_ID: BasemapId = 'osm';

/**
 * Look up a basemap by id. Returns `undefined` if the id is unknown; the
 * caller decides how to handle that (typically falls back to
 * `DEFAULT_BASEMAP_ID`).
 */
export function findBasemap(id: BasemapId): Basemap | undefined {
    return BASEMAPS.find((b) => b.id === id);
}

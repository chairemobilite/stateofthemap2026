//! MapLibre GL map container.
//!
//! Creates the map once on mount, destroys it on unmount, and reacts to
//! prop changes:
//! - `basemapId` → `map.setStyle(...)` in-place;
//! - `bbox`      → replace the `bbox` GeoJSON source and fit the viewport.
//!
//! `setStyle` wipes every custom source/layer, so the bbox overlay is
//! re-installed on the next `style.load` event.

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Bbox } from './api';
import { findBasemap, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { toBounds, toPolygon } from './bboxGeoJson';

export interface MapViewProps {
    basemapId: BasemapId;
    bbox: Bbox | null;
}

const BBOX_SOURCE = 'bbox';
const BBOX_FILL_LAYER = 'bbox-fill';
const BBOX_OUTLINE_LAYER = 'bbox-outline';

/** (Re)install the bbox source + layers on an already-loaded style. */
function installBboxLayers(map: MapLibreMap, bbox: Bbox | null) {
    if (map.getLayer(BBOX_FILL_LAYER)) map.removeLayer(BBOX_FILL_LAYER);
    if (map.getLayer(BBOX_OUTLINE_LAYER)) map.removeLayer(BBOX_OUTLINE_LAYER);
    if (map.getSource(BBOX_SOURCE)) map.removeSource(BBOX_SOURCE);
    if (!bbox) return;

    map.addSource(BBOX_SOURCE, { type: 'geojson', data: toPolygon(bbox) });
    map.addLayer({
        id: BBOX_FILL_LAYER,
        type: 'fill',
        source: BBOX_SOURCE,
        paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.15 },
    });
    map.addLayer({
        id: BBOX_OUTLINE_LAYER,
        type: 'line',
        source: BBOX_SOURCE,
        paint: { 'line-color': '#1d4ed8', 'line-width': 2 },
    });
}

export function MapView({ basemapId, bbox }: MapViewProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    // Latest bbox, read by the `style.load` handler after a basemap switch.
    const bboxRef = useRef<Bbox | null>(bbox);
    bboxRef.current = bbox;

    // Create the map once. Basemap and bbox are kept in sync by the
    // effects below — the MapLibre instance has its own lifecycle and
    // must not be rebuilt on every prop change.
    useEffect(() => {
        if (!containerRef.current) return;

        const initial = findBasemap(basemapId) ?? findBasemap(DEFAULT_BASEMAP_ID)!;
        const map = new maplibregl.Map({
            container: containerRef.current,
            style: initial.style,
            center: [0, 20],
            zoom: 1.5,
        });
        mapRef.current = map;

        // `setStyle` wipes custom layers, so re-install the bbox overlay
        // every time the style reloads.
        map.on('style.load', () => installBboxLayers(map, bboxRef.current));

        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Swap the style when the active basemap changes.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const basemap = findBasemap(basemapId);
        if (basemap) {
            map.setStyle(basemap.style);
        }
    }, [basemapId]);

    // Sync the bbox overlay and fit the viewport to it.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        installBboxLayers(map, bbox);
        if (bbox) {
            map.fitBounds(toBounds(bbox), { padding: 40, duration: 500 });
        }
    }, [bbox]);

    return <div ref={containerRef} className="map-view" data-testid="map-view" />;
}

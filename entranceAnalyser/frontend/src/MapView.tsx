//! MapLibre GL map container.
//!
//! Creates the map once on mount, destroys it on unmount, and reacts to
//! prop changes:
//! - `basemapId` → `map.setStyle(...)` in-place;
//! - `bbox`      → replace the `bbox` GeoJSON source and fit the viewport.
//!
//! `setStyle` wipes every custom source/layer, so the bbox overlay is
//! reinstalled every time `style.load` fires.

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

/**
 * (Re)install the bbox source + layers. The caller is responsible for
 * checking that the map's style is loaded — on an unloaded style
 * `getLayer` / `addSource` throw.
 */
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
    // Keep the latest bbox reachable from the `style.load` handler, which
    // fires outside of React's update cycle.
    const bboxRef = useRef<Bbox | null>(bbox);
    useEffect(() => {
        bboxRef.current = bbox;
    });

    // Create the map once. `style.load` is the single point where the
    // bbox overlay is (re)installed, so we never touch the style while
    // it is still loading.
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

        map.on('style.load', () => {
            installBboxLayers(map, bboxRef.current);
            if (bboxRef.current) {
                map.fitBounds(toBounds(bboxRef.current), { padding: 40, duration: 500 });
            }
        });
        // Surface MapLibre errors in the dev console — they are otherwise
        // swallowed silently and show up only as a blank canvas.
        map.on('error', (e) => console.error('[MapLibre]', e.error ?? e));

        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Swap the style when the active basemap changes. Skip the first
    // render because the mount effect already initialised the map with
    // the current basemap — calling `setStyle` with the same style
    // while it is still loading triggers a full rebuild and races with
    // the initial tile fetches.
    const lastBasemapRef = useRef<BasemapId>(basemapId);
    useEffect(() => {
        if (lastBasemapRef.current === basemapId) return;
        lastBasemapRef.current = basemapId;
        const map = mapRef.current;
        if (!map) return;
        const basemap = findBasemap(basemapId);
        if (basemap) map.setStyle(basemap.style);
    }, [basemapId]);

    // Sync the bbox overlay. If the style is loaded we install it
    // immediately; otherwise we wait for the first `idle` event so the
    // first bbox arriving during the initial style load is not dropped.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const apply = () => {
            installBboxLayers(map, bbox);
            if (bbox) {
                map.fitBounds(toBounds(bbox), { padding: 40, duration: 500 });
            }
        };
        if (map.isStyleLoaded()) {
            apply();
            return;
        }
        map.once('idle', apply);
        return () => {
            map.off('idle', apply);
        };
    }, [bbox]);

    return <div ref={containerRef} className="map-view" data-testid="map-view" />;
}

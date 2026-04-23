//! MapLibre GL map container.
//!
//! Creates the map once (on mount), destroys it on unmount, and reacts to
//! `basemapId` prop changes by swapping the style in-place. The map
//! instance itself is intentionally not exposed — PR 4 will add a
//! callback/ref for the bbox overlay.

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { findBasemap, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';

export interface MapViewProps {
    basemapId: BasemapId;
}

export function MapView({ basemapId }: MapViewProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);

    // Create the map once. The basemap is resolved at mount and kept in sync
    // by the second effect. An empty dependency array is intentional — the
    // MapLibre instance has its own lifecycle and must not be rebuilt on
    // every basemap change.
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

    return <div ref={containerRef} className="map-view" data-testid="map-view" />;
}

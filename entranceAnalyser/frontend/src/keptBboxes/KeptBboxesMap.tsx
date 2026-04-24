//! World-overview map of every kept bbox.
//!
//! Mirrors `MapView`'s lifecycle (create on mount, destroy on unmount,
//! re-install sources/layers on every `style.load`) but renders an
//! array of bboxes via two zoom-gated layers:
//!
//!  - `fill` + `line` for rectangles at `zoom >= RECT_MIN_ZOOM`
//!  - `circle` markers at the cell centers at `zoom < RECT_MIN_ZOOM`
//!
//! Clicking either opens a MapLibre popup hosting a React root that
//! renders `<KeptBboxRow />`, so the popup body stays in sync with the
//! list-row shape without duplicating markup.

import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import maplibregl, {
    type Map as MapLibreMap,
    type MapGeoJSONFeature,
    type MapMouseEvent,
    Popup,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { KeptBbox } from '../api';
import { DEFAULT_BASEMAP_ID, findBasemap, type BasemapId } from '../basemaps';
import { KeptBboxRow } from './KeptBboxRow';
import {
    toCenterCollection,
    toCollectiveBounds,
    toPolygonCollection,
} from './keptBboxesGeoJson';
import type { KeptBboxesStatus } from './useKeptBboxes';

export interface KeptBboxesMapProps {
    keptBboxes: KeptBbox[];
    basemapId: BasemapId;
    status: KeptBboxesStatus;
    error: string | null;
}

const POLY_SOURCE = 'kept-polygons';
const POINT_SOURCE = 'kept-points';
const FILL_LAYER = 'kept-fill';
const LINE_LAYER = 'kept-outline';
const CIRCLE_LAYER = 'kept-circle';

/**
 * Zoom threshold above which polygon rectangles replace circle markers.
 * At z=6 a 10 km cell is ~12 pixels across, comfortably larger than a
 * circle marker — below that the rectangles shrink to sub-pixel size
 * and a plain dot reads better.
 */
const RECT_MIN_ZOOM = 6;

type MapLibreClickEvent = MapMouseEvent & { features?: MapGeoJSONFeature[] };

/**
 * Install the kept-bboxes sources + layers on the map. Removes any
 * prior installation first so style swaps and data refreshes share the
 * same code path. The caller must have verified the style is loaded.
 *
 * @param map - Active MapLibre map.
 * @param keptBboxes - Current list of kept bboxes to render.
 */
function installKeptLayers(map: MapLibreMap, keptBboxes: KeptBbox[]) {
    for (const layer of [FILL_LAYER, LINE_LAYER, CIRCLE_LAYER]) {
        if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of [POLY_SOURCE, POINT_SOURCE]) {
        if (map.getSource(source)) map.removeSource(source);
    }

    map.addSource(POLY_SOURCE, { type: 'geojson', data: toPolygonCollection(keptBboxes) });
    map.addSource(POINT_SOURCE, { type: 'geojson', data: toCenterCollection(keptBboxes) });

    map.addLayer({
        id: FILL_LAYER,
        type: 'fill',
        source: POLY_SOURCE,
        minzoom: RECT_MIN_ZOOM,
        paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.18 },
    });
    map.addLayer({
        id: LINE_LAYER,
        type: 'line',
        source: POLY_SOURCE,
        minzoom: RECT_MIN_ZOOM,
        paint: { 'line-color': '#1d4ed8', 'line-width': 1.5 },
    });
    map.addLayer({
        id: CIRCLE_LAYER,
        type: 'circle',
        source: POINT_SOURCE,
        maxzoom: RECT_MIN_ZOOM,
        paint: {
            'circle-radius': 5,
            'circle-color': '#1d4ed8',
            'circle-opacity': 0.85,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
        },
    });
}

export function KeptBboxesMap({ keptBboxes, basemapId, status, error }: KeptBboxesMapProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);

    // Keep the latest bboxes reachable from async MapLibre callbacks
    // that fire outside React's update cycle (style.load, click).
    const keptRef = useRef(keptBboxes);
    useEffect(() => {
        keptRef.current = keptBboxes;
    });

    // Track whether fit-bounds has already run, so reloads via the
    // hook's `reload()` don't yank the user's current pan/zoom.
    const hasFitRef = useRef(false);

    // Exactly one popup at a time, with its React root in parallel.
    const popupRef = useRef<Popup | null>(null);
    const popupRootRef = useRef<Root | null>(null);

    /**
     * Tear down any prior popup/root, then mount a fresh one at the
     * bbox's center hosting a `<KeptBboxRow />`. MapLibre's `close`
     * event unmounts the root we created here, guarded so a popup
     * already replaced by a newer one does not double-unmount.
     */
    const openPopup = (map: MapLibreMap, bbox: KeptBbox) => {
        popupRootRef.current?.unmount();
        popupRef.current?.remove();

        const node = document.createElement('div');
        const root = createRoot(node);
        root.render(<KeptBboxRow bbox={bbox} status="not_started" />);

        const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
            .setLngLat(bbox.center)
            .setDOMContent(node)
            .addTo(map);
        popup.on('close', () => {
            if (popupRootRef.current === root) {
                root.unmount();
                popupRef.current = null;
                popupRootRef.current = null;
            }
        });
        popupRef.current = popup;
        popupRootRef.current = root;
    };

    // Create the map once. Registers click handlers for both feature
    // layers so the same popup pipeline fires whether the user sees
    // circles (low zoom) or rectangles (high zoom).
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
            installKeptLayers(map, keptRef.current);
        });
        map.on('error', (e) => console.error('[MapLibre]', e.error ?? e));

        const handleClick = (e: MapLibreClickEvent) => {
            const feature = e.features?.[0];
            const featureId = feature?.properties?.id as string | undefined;
            const bbox = keptRef.current.find((b) => b.id === featureId);
            if (!bbox) return;
            openPopup(map, bbox);
        };
        map.on('click', FILL_LAYER, handleClick);
        map.on('click', CIRCLE_LAYER, handleClick);

        // Cursor affordance on hoverable features.
        const enter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const leave = () => {
            map.getCanvas().style.cursor = '';
        };
        for (const layer of [FILL_LAYER, CIRCLE_LAYER]) {
            map.on('mouseenter', layer, enter);
            map.on('mouseleave', layer, leave);
        }

        return () => {
            popupRef.current?.remove();
            popupRootRef.current?.unmount();
            popupRef.current = null;
            popupRootRef.current = null;
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Swap the basemap style when the prop changes. Skip the first
    // render because the mount effect already initialised with it.
    const lastBasemapRef = useRef<BasemapId>(basemapId);
    useEffect(() => {
        if (lastBasemapRef.current === basemapId) return;
        lastBasemapRef.current = basemapId;
        const map = mapRef.current;
        if (!map) return;
        const basemap = findBasemap(basemapId);
        if (basemap) map.setStyle(basemap.style);
    }, [basemapId]);

    // Sync bboxes → sources on every data change; fit bounds exactly
    // once so subsequent `reload()`s leave the user's view alone.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const apply = () => {
            installKeptLayers(map, keptBboxes);
            if (hasFitRef.current) return;
            const bounds = toCollectiveBounds(keptBboxes);
            if (bounds) {
                map.fitBounds(bounds, { padding: 48, duration: 500, maxZoom: 10 });
                hasFitRef.current = true;
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
    }, [keptBboxes]);

    return (
        <div className="kept-bboxes-map">
            <div
                ref={containerRef}
                className="kept-bboxes-map__canvas"
                data-testid="kept-bboxes-map"
            />
            {status === 'loading' && (
                <p className="kept-bboxes-map__status">Loading…</p>
            )}
            {status === 'error' && error && (
                <p className="kept-bboxes-map__error" role="alert">
                    {error}
                </p>
            )}
            {status === 'idle' && keptBboxes.length === 0 && (
                <p className="kept-bboxes-map__status">
                    No bboxes kept yet. Switch to the Sampling screen to add some.
                </p>
            )}
        </div>
    );
}

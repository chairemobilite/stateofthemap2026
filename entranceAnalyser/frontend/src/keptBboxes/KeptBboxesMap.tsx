//! World-overview map of every kept bbox.
//!
//! Mirrors `MapView`'s lifecycle (create on mount, destroy on unmount,
//! re-install sources/layers on every `style.load`) but renders an
//! array of bboxes via two zoom-gated layers:
//!
//!  - `fill` + `line` for rectangles at `zoom >= RECT_MIN_ZOOM`
//!  - `circle` markers at the cell centers at `zoom < RECT_MIN_ZOOM`
//!
//! On top of those, a separate `poi-markers` layer paints picked POIs
//! (orange dots) at every zoom, so the user can spot which kept cells
//! already have an analysis cached.
//!
//! Clicking a bbox layer opens a MapLibre popup hosting a React root
//! that renders `<KeptBboxPopup />` — the bbox row plus the
//! Pick POI control. The popup re-renders in place when picks/picking
//! change for the open bbox, so the button can flip to "Picking…" and
//! then to the picked POI without closing the popup.

import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import maplibregl, {
    type Map as MapLibreMap,
    type MapGeoJSONFeature,
    type MapMouseEvent,
    Popup,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { KeptBbox, Poi } from '../api';
import { DEFAULT_BASEMAP_ID, findBasemap, type BasemapId } from '../basemaps';
import { KeptBboxPopup } from './KeptBboxPopup';
import {
    toCenterCollection,
    toCollectiveBounds,
    toPoiCollection,
    toPolygonCollection,
} from './keptBboxesGeoJson';
import type { KeptBboxesStatus } from './useKeptBboxes';

export interface KeptBboxesMapProps {
    keptBboxes: KeptBbox[];
    basemapId: BasemapId;
    status: KeptBboxesStatus;
    error: string | null;
    /** Per-bbox picked POI map, keyed by bbox id. `undefined` means
     *  no pick yet, `null` means Overpass matched nothing. */
    picks: Record<string, Poi | null>;
    /** Bbox ids currently fetching a pick, so the popup can disable
     *  the button without blocking other rows. */
    picking: Set<string>;
    /** Triggered by the "Pick POI" button inside the popup. */
    onPickPoi: (bboxId: string) => void;
}

const POLY_SOURCE = 'kept-polygons';
const POINT_SOURCE = 'kept-points';
const POI_SOURCE = 'poi-picks';
const FILL_LAYER = 'kept-fill';
const LINE_LAYER = 'kept-outline';
const CIRCLE_LAYER = 'kept-circle';
const POI_LAYER = 'poi-markers';

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
 * @param picks - Per-bbox picked POI map for the marker layer.
 */
function installKeptLayers(
    map: MapLibreMap,
    keptBboxes: KeptBbox[],
    picks: Record<string, Poi | null>,
) {
    for (const layer of [FILL_LAYER, LINE_LAYER, CIRCLE_LAYER, POI_LAYER]) {
        if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of [POLY_SOURCE, POINT_SOURCE, POI_SOURCE]) {
        if (map.getSource(source)) map.removeSource(source);
    }

    map.addSource(POLY_SOURCE, { type: 'geojson', data: toPolygonCollection(keptBboxes) });
    map.addSource(POINT_SOURCE, { type: 'geojson', data: toCenterCollection(keptBboxes) });
    map.addSource(POI_SOURCE, { type: 'geojson', data: toPoiCollection(picks) });

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
    map.addLayer({
        id: POI_LAYER,
        type: 'circle',
        source: POI_SOURCE,
        paint: {
            'circle-radius': 4,
            'circle-color': '#f97316',
            'circle-opacity': 0.95,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.25,
        },
    });
}

/** Refresh just the POI marker source without touching the bbox
 *  layers, for the cheap path when only `picks` changed. */
function updatePoiSource(map: MapLibreMap, picks: Record<string, Poi | null>) {
    const source = map.getSource(POI_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(toPoiCollection(picks));
}

export function KeptBboxesMap({
    keptBboxes,
    basemapId,
    status,
    error,
    picks,
    picking,
    onPickPoi,
}: KeptBboxesMapProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);

    // Keep the latest collections reachable from async MapLibre callbacks
    // (style.load, click) that fire outside React's update cycle.
    const keptRef = useRef(keptBboxes);
    const picksRef = useRef(picks);
    const pickingRef = useRef(picking);
    const onPickPoiRef = useRef(onPickPoi);
    useEffect(() => {
        keptRef.current = keptBboxes;
    });
    useEffect(() => {
        picksRef.current = picks;
    });
    useEffect(() => {
        pickingRef.current = picking;
    });
    useEffect(() => {
        onPickPoiRef.current = onPickPoi;
    });

    // Track whether fit-bounds has already run, so reloads via the
    // hook's `reload()` don't yank the user's current pan/zoom.
    const hasFitRef = useRef(false);

    // Exactly one popup at a time, with its React root in parallel.
    // `popupBboxRef` holds the id of the bbox the open popup shows so
    // the picks/picking effects can re-render its body in place.
    const popupRef = useRef<Popup | null>(null);
    const popupRootRef = useRef<Root | null>(null);
    const popupBboxRef = useRef<string | null>(null);

    /**
     * Render the popup body for `bbox` into `root`, reading the latest
     * pick state from refs so callers don't have to thread props in.
     */
    const renderPopupBody = (root: Root, bbox: KeptBbox) => {
        root.render(
            <KeptBboxPopup
                bbox={bbox}
                pickedPoi={picksRef.current[bbox.id]}
                isPicking={pickingRef.current.has(bbox.id)}
                onPick={(id) => onPickPoiRef.current(id)}
            />,
        );
    };

    /**
     * Tear down any prior popup/root, then mount a fresh one at the
     * bbox's center. MapLibre's `close` event unmounts the root we
     * created here, guarded so a popup already replaced by a newer
     * one does not double-unmount.
     */
    const openPopup = (map: MapLibreMap, bbox: KeptBbox) => {
        popupRootRef.current?.unmount();
        popupRef.current?.remove();

        const node = document.createElement('div');
        const root = createRoot(node);
        renderPopupBody(root, bbox);

        const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
            .setLngLat(bbox.center)
            .setDOMContent(node)
            .addTo(map);
        popup.on('close', () => {
            if (popupRootRef.current === root) {
                root.unmount();
                popupRef.current = null;
                popupRootRef.current = null;
                popupBboxRef.current = null;
            }
        });
        popupRef.current = popup;
        popupRootRef.current = root;
        popupBboxRef.current = bbox.id;
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
            installKeptLayers(map, keptRef.current, picksRef.current);
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
        for (const layer of [FILL_LAYER, CIRCLE_LAYER, POI_LAYER]) {
            map.on('mouseenter', layer, enter);
            map.on('mouseleave', layer, leave);
        }

        return () => {
            popupRef.current?.remove();
            popupRootRef.current?.unmount();
            popupRef.current = null;
            popupRootRef.current = null;
            popupBboxRef.current = null;
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
            installKeptLayers(map, keptBboxes, picksRef.current);
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

    // Refresh the POI marker layer + open popup whenever picks or
    // picking changes. Cheap path: just `setData` on the existing
    // source rather than re-installing every layer.
    useEffect(() => {
        const map = mapRef.current;
        if (map && map.isStyleLoaded()) updatePoiSource(map, picks);

        const root = popupRootRef.current;
        const openId = popupBboxRef.current;
        if (!root || !openId) return;
        const bbox = keptBboxes.find((b) => b.id === openId);
        if (bbox) renderPopupBody(root, bbox);
    }, [picks, picking, keptBboxes]);

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

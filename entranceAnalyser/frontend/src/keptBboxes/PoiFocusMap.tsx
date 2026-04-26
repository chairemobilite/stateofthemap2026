//! Focus map: zoom in on one picked POI and paint its surrounding
//! buildings + entrances inside the configured buffer ring.
//!
//! Pure presentational MapLibre wrapper, mirroring `KeptBboxesMap`'s
//! lifecycle (create on mount, install sources/layers on every
//! `style.load`, basemap swaps via `setStyle`). Owns no fetch state of
//! its own — the parent threads in `focus`, `loading`, `error`, and a
//! `loadFocus` action so the same `usePoiFocus` instance can power
//! both this view and the overview map's hydration on load.
//!
//! Layers, in render order:
//!  - building polygons (translucent fill + outline)
//!  - buffer ring (`radius_m` echoed from the backend, drawn as a
//!    LineString so the basemap underneath stays readable)
//!  - entrance markers (small green dots)
//!  - picked POI marker (orange dot, identical to the overview map
//!    so the visual lineage from the popup is obvious)

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { KeptBbox, Poi, PoiFocusResult } from '../api';
import { DEFAULT_BASEMAP_ID, findBasemap, type BasemapId } from '../basemaps';
import { MapContextMenu, type MapContextMenuItem } from './MapContextMenu';
import {
    amapUrl,
    baiduPanoramaUrl,
    googleStreetViewUrl,
    kartaViewUrl,
    mapillaryUrl,
    osmEditorUrl,
    panoramaxUrl,
    type MapPoint,
} from './mapLinks';
import {
    FOCUS_RADIUS_DEFAULT_M,
    FOCUS_RADIUS_MAX_M,
    FOCUS_RADIUS_MIN_M,
    parseFocusRadiusInput,
} from './focusRadius';
import {
    toBufferRing,
    toBuildingsCollection,
    toEntrancesCollection,
    toFocusBounds,
    toPickedPoiCollection,
} from './poiFocusGeoJson';

export interface PoiFocusMapProps {
    bbox: KeptBbox;
    pickedPoi: Poi;
    /** Server-cached focus payload. `undefined` while still loading
     *  or after a failure; the parent owns the `loadFocus` trigger. */
    focus: PoiFocusResult | undefined;
    /** True while a `loadFocus` request for `bbox.id` is in flight. */
    loading: boolean;
    error: string | null;
    basemapId: BasemapId;
    /** Return to the overview view; the parent decides what that means. */
    onBack: () => void;
    /** Triggered on mount when no cached focus is available, and on
     *  every form submission once the user changes the radius. The
     *  optional `radiusM` is forwarded to the backend's
     *  `?radius_m=` override; omit it to fall back to the server's
     *  default. */
    onLoadFocus: (bboxId: string, radiusM?: number) => void;
    /** OSM editor URL template, normally fetched via `useAppConfig`.
     *  Threaded as a prop instead of read from a hook here so this
     *  component stays a pure MapLibre wrapper that's easy to test in
     *  isolation. The `{lat}`, `{lon}`, `{zoom}` placeholders are
     *  substituted by `mapLinks.osmEditorUrl`. */
    osmEditorUrlTemplate: string;
}

/** State for the right-click context menu: where to draw it (in
 *  canvas-relative CSS pixels) and which geo-coords to deeplink. */
interface MenuState {
    position: { x: number; y: number };
    point: MapPoint;
}

const BUILDINGS_SOURCE = 'focus-buildings';
const ENTRANCES_SOURCE = 'focus-entrances';
const PICKED_SOURCE = 'focus-picked';
const RING_SOURCE = 'focus-ring';

const BUILDINGS_FILL = 'focus-buildings-fill';
const BUILDINGS_LINE = 'focus-buildings-line';
const RING_LINE = 'focus-ring-line';
const ENTRANCES_LAYER = 'focus-entrances';
const PICKED_LAYER = 'focus-picked';

const FOCUS_LAYER_IDS = [
    BUILDINGS_FILL,
    BUILDINGS_LINE,
    RING_LINE,
    ENTRANCES_LAYER,
    PICKED_LAYER,
];
const FOCUS_SOURCE_IDS = [BUILDINGS_SOURCE, ENTRANCES_SOURCE, PICKED_SOURCE, RING_SOURCE];

/**
 * Install the focus sources + layers, replacing any prior installation
 * so style swaps and data refreshes share the same code path. Caller
 * must ensure the style is loaded.
 */
function installFocusLayers(
    map: MapLibreMap,
    pickedPoi: Poi,
    focus: PoiFocusResult | undefined,
) {
    for (const layer of FOCUS_LAYER_IDS) {
        if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of FOCUS_SOURCE_IDS) {
        if (map.getSource(source)) map.removeSource(source);
    }

    const empty = { type: 'FeatureCollection' as const, features: [] };
    const buildings = focus ? toBuildingsCollection(focus) : empty;
    const entrances = focus ? toEntrancesCollection(focus) : empty;
    const ringFeature = focus
        ? toBufferRing(focus.center, focus.radius_m)
        : toBufferRing(pickedPoi.center, 0);
    const ring = { type: 'FeatureCollection' as const, features: [ringFeature] };

    map.addSource(BUILDINGS_SOURCE, { type: 'geojson', data: buildings });
    map.addSource(ENTRANCES_SOURCE, { type: 'geojson', data: entrances });
    map.addSource(RING_SOURCE, { type: 'geojson', data: ring });
    map.addSource(PICKED_SOURCE, { type: 'geojson', data: toPickedPoiCollection(pickedPoi) });

    map.addLayer({
        id: BUILDINGS_FILL,
        type: 'fill',
        source: BUILDINGS_SOURCE,
        paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.25 },
    });
    map.addLayer({
        id: BUILDINGS_LINE,
        type: 'line',
        source: BUILDINGS_SOURCE,
        paint: { 'line-color': '#1d4ed8', 'line-width': 1 },
    });
    map.addLayer({
        id: RING_LINE,
        type: 'line',
        source: RING_SOURCE,
        paint: {
            'line-color': '#f97316',
            'line-width': 1.5,
            'line-dasharray': [2, 2],
        },
    });
    map.addLayer({
        id: ENTRANCES_LAYER,
        type: 'circle',
        source: ENTRANCES_SOURCE,
        paint: {
            'circle-radius': 5,
            'circle-color': '#16a34a',
            'circle-opacity': 0.9,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.25,
        },
    });
    map.addLayer({
        id: PICKED_LAYER,
        type: 'circle',
        source: PICKED_SOURCE,
        paint: {
            'circle-radius': 7,
            'circle-color': '#f97316',
            'circle-opacity': 1,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2,
        },
    });
}

export function PoiFocusMap({
    bbox,
    pickedPoi,
    focus,
    loading,
    error,
    basemapId,
    onBack,
    onLoadFocus,
    osmEditorUrlTemplate,
}: PoiFocusMapProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const focusRef = useRef(focus);
    const pickedRef = useRef(pickedPoi);
    const [menuState, setMenuState] = useState<MenuState | null>(null);
    useEffect(() => {
        focusRef.current = focus;
    });
    useEffect(() => {
        pickedRef.current = pickedPoi;
    });

    // Trigger one fetch on mount when the cache is cold. We don't
    // re-trigger on `bbox.id` change because the parent re-mounts this
    // component when switching to a different bbox (key on view).
    const triggeredRef = useRef(false);
    useEffect(() => {
        if (triggeredRef.current) return;
        if (focus !== undefined) return;
        triggeredRef.current = true;
        onLoadFocus(bbox.id);
    }, [bbox.id, focus, onLoadFocus]);

    // Radius form: seeded from the cached focus when present (so
    // re-opening a bbox shows the radius the cached row was computed
    // at) and from `FOCUS_RADIUS_DEFAULT_M` otherwise. Stored as a
    // string to allow intermediate edits ("", "1", "12") without
    // resetting the cursor. The set-during-render pattern keeps the
    // input in sync when the cached row arrives later (cold load) or
    // changes (user submitted a different radius).
    const [radiusInput, setRadiusInput] = useState<string>(() =>
        String(focus?.radius_m ?? FOCUS_RADIUS_DEFAULT_M),
    );
    const [lastSyncedRadius, setLastSyncedRadius] = useState<number | undefined>(
        focus?.radius_m,
    );
    if (focus && focus.radius_m !== lastSyncedRadius) {
        setLastSyncedRadius(focus.radius_m);
        setRadiusInput(String(focus.radius_m));
    }

    const parsedRadius = useMemo(() => parseFocusRadiusInput(radiusInput), [radiusInput]);
    const radiusUnchanged = focus !== undefined && parsedRadius === focus.radius_m;
    const submitDisabled = loading || parsedRadius === null || radiusUnchanged;

    const handleRadiusSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (submitDisabled || parsedRadius === null) return;
        onLoadFocus(bbox.id, parsedRadius);
    };

    useEffect(() => {
        if (!containerRef.current) return;
        const initial = findBasemap(basemapId) ?? findBasemap(DEFAULT_BASEMAP_ID)!;
        // Frame the buffer ring on first load even before Overpass
        // returns: the parent is allowed to mount us with no cached
        // focus, and we still want a useful zoom level.
        const radiusM = focusRef.current?.radius_m ?? 200;
        const center = focusRef.current?.center ?? pickedRef.current.center;
        const map = new maplibregl.Map({
            container: containerRef.current,
            style: initial.style,
            center,
            zoom: 17,
        });
        map.fitBounds(toFocusBounds(center, radiusM), {
            padding: 32,
            duration: 0,
            maxZoom: 19,
        });
        mapRef.current = map;

        map.on('style.load', () => {
            installFocusLayers(map, pickedRef.current, focusRef.current);
        });
        map.on('error', (e) => console.error('[MapLibre]', e.error ?? e));
        // Right-click → open the "open in …" menu at the click point.
        // `e.point` is canvas-local CSS pixels, which matches the
        // absolute positioning of `<MapContextMenu>` because it sits
        // inside the same positioned ancestor as the canvas. We call
        // `preventDefault()` so the browser's native menu doesn't
        // briefly flash before ours appears.
        map.on('contextmenu', (e) => {
            e.preventDefault();
            setMenuState({
                position: { x: e.point.x, y: e.point.y },
                point: { lat: e.lngLat.lat, lon: e.lngLat.lng, zoom: map.getZoom() },
            });
        });

        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Build the menu items lazily — only when there's a click to
    // service. Template substitution and datum conversion are cheap,
    // but recomputing them once per re-render still wastes work in
    // the common "no menu open" case.
    const menuItems = useMemo<MapContextMenuItem[]>(() => {
        if (menuState === null) return [];
        const p = menuState.point;
        return [
            { key: 'mapillary', label: 'Open in Mapillary', href: mapillaryUrl(p) },
            { key: 'panoramax', label: 'Open in Panoramax', href: panoramaxUrl(p) },
            { key: 'kartaview', label: 'Open in KartaView', href: kartaViewUrl(p) },
            { key: 'gsv', label: 'Open in Google Street View', href: googleStreetViewUrl(p) },
            { key: 'baidu', label: 'Open in Baidu (百度地图)', href: baiduPanoramaUrl(p) },
            { key: 'amap', label: 'Open in AMap (高德地图)', href: amapUrl(p) },
            { key: 'osm', label: 'Edit on OpenStreetMap', href: osmEditorUrl(osmEditorUrlTemplate, p) },
        ];
    }, [menuState, osmEditorUrlTemplate]);

    // Basemap swap path mirrors KeptBboxesMap exactly.
    const lastBasemapRef = useRef<BasemapId>(basemapId);
    useEffect(() => {
        if (lastBasemapRef.current === basemapId) return;
        lastBasemapRef.current = basemapId;
        const map = mapRef.current;
        if (!map) return;
        const basemap = findBasemap(basemapId);
        if (basemap) map.setStyle(basemap.style);
    }, [basemapId]);

    // Re-install layers + re-fit bounds whenever the focus payload
    // changes. The fit bounds is recomputed each time so radius
    // tweaks (e.g., POI_FOCUS_RADIUS_M restart) reframe the view.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const apply = () => {
            installFocusLayers(map, pickedPoi, focus);
            if (focus) {
                map.fitBounds(toFocusBounds(focus.center, focus.radius_m), {
                    padding: 32,
                    duration: 250,
                    maxZoom: 19,
                });
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
    }, [focus, pickedPoi]);

    return (
        <div className="poi-focus-map">
            <header className="poi-focus-map__header">
                <button
                    type="button"
                    className="poi-focus-map__back"
                    onClick={onBack}
                >
                    ← Back
                </button>
                <div className="poi-focus-map__title">
                    <strong>Focus:</strong>{' '}
                    {pickedPoi.tags['name'] ??
                        `${pickedPoi.osm_type} ${pickedPoi.osm_id}`}{' '}
                    <span className="poi-focus-map__group">({pickedPoi.group})</span>
                </div>
                {focus && (
                    <div className="poi-focus-map__counts" aria-label="Feature counts">
                        <span>{focus.buildings.features.length} buildings</span>
                        <span>{focus.entrances.features.length} entrances</span>
                    </div>
                )}
                <form
                    className="poi-focus-map__radius"
                    onSubmit={handleRadiusSubmit}
                    aria-label="Focus radius"
                >
                    <label htmlFor="poi-focus-radius-input">Radius (m)</label>
                    <input
                        id="poi-focus-radius-input"
                        type="number"
                        inputMode="numeric"
                        min={FOCUS_RADIUS_MIN_M}
                        max={FOCUS_RADIUS_MAX_M}
                        step={10}
                        value={radiusInput}
                        onChange={(e) => setRadiusInput(e.target.value)}
                        disabled={loading}
                        aria-invalid={parsedRadius === null}
                        aria-describedby="poi-focus-radius-help"
                    />
                    <button type="submit" disabled={submitDisabled}>
                        Apply
                    </button>
                    <span id="poi-focus-radius-help" className="poi-focus-map__radius-help">
                        {FOCUS_RADIUS_MIN_M}–{FOCUS_RADIUS_MAX_M} m
                    </span>
                </form>
            </header>

            <div
                ref={containerRef}
                className="poi-focus-map__canvas"
                data-testid="poi-focus-map"
            >
                {/* The menu lives inside MapLibre's container so its
                 *  `position: absolute` resolves against the canvas
                 *  itself — `e.point` is canvas-local and matches
                 *  one-to-one. React happily reconciles its single
                 *  optional child alongside MapLibre's <canvas>; this
                 *  is the same pattern react-map-gl uses for markers
                 *  and popups. */}
                <MapContextMenu
                    position={menuState?.position ?? null}
                    items={menuItems}
                    onDismiss={() => setMenuState(null)}
                />
            </div>

            {loading && <p className="poi-focus-map__status">Loading buildings &amp; entrances…</p>}
            {error && (
                <p className="poi-focus-map__error" role="alert">
                    {error}
                </p>
            )}
            {!loading && !error && focus && focus.buildings.features.length === 0 && focus.entrances.features.length === 0 && (
                <p className="poi-focus-map__status">
                    Overpass returned no buildings or entrances inside the buffer.
                </p>
            )}
        </div>
    );
}

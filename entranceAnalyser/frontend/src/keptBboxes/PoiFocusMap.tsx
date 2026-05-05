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
//!  - building-centroid dots (grey anchors when the POI is a node inside a polygon)
//!  - picked POI marker (orange while in progress, green when the row
//!    is marked completed — same colours as the overview map)
//!  - persisted measurement polylines (grey) + wide invisible hit target
//!  - draft polyline + waypoints painted *above* buildings so they receive
//!    pointer events: click line → insert vertex, click handle → remove,
//!    drag handle → move (post-drag click suppressed so no stray vertex).
//!  `doubleClickZoom` is off so double-clicks while drawing do not zoom in.
//!  The focus ring `fitBounds` runs only when centre/radius change, not when
//!  measurement vertex count changes (otherwise each new point would re-zoom).
//!  Clicks within ANCHOR_UI_GUARD_PX of the projected POI focus centre,
//!  entrance, or building centroid do not **select a saved grey line** (panel
//!  closed only) so anchor picks are not mistaken for line picks. While the
//!  measure panel is open, the same px radius snaps **every** new vertex to
//!  those anchors when the click lands there (centroid then entrance/building
//!  snap order unchanged).
//!  A saved grey line is selected by click only when the measure panel is
//!  closed (`!panelOpen`) so drafts can cross other paths; opening the panel
//!  (new line or loaded row) blocks pick-until-close.

import {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
} from 'react';
import maplibregl, { type Map as MapLibreMap, type LngLatLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type {
    KeptBbox,
    Poi,
    PoiFocusMeasurement,
    PoiFocusMeasurementWriteBody,
    PoiFocusResult,
    PoiRejectionReason,
} from '../api';
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
import { toSavedMeasurementsFeatureCollection } from './focusMeasurementGeoJson';
import {
    ENTRANCE_TYPE_LABELS,
    ENTRANCE_TYPES,
    MEASUREMENT_PURPOSE_LABELS,
    MEASUREMENT_PURPOSES,
    isEntranceType,
    isMeasurementPurpose,
    type EntranceType,
    type MeasurementPurpose,
} from './measurementCatalog';
import {
    DEFAULT_WALKING_SPEED_KMH,
    ANCHOR_UI_GUARD_PX,
    calculatePathLength,
    estimateWalkingTimeMinutes,
    insertVertexAlongPolyline,
    parseWalkingSpeedInput,
    pixelDistance,
    snapClickToNearestAnchorPx,
} from './measure';
import { inferMeasurementStart } from './measurementStart';
import {
    buildingCentroidPointsForSnap,
    entranceCentersFromFocus,
    toBufferRing,
    toBuildingsCollection,
    toBuildingCentroidsCollection,
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
    /** Triggered on mount when no cached focus is available, on
     *  every form submission once the user changes the radius, and
     *  when the user asks to refresh from Overpass. The optional
     *  `radiusM` is forwarded to the backend's `?radius_m=`
     *  override; omit it to fall back to the server's default.
     *  Pass `{ refresh: true }` to bypass the server's focus row
     *  cache and re-query Overpass at the given radius. */
    onLoadFocus: (
        bboxId: string,
        radiusM?: number,
        opts?: { refresh?: boolean },
    ) => void;
    /** OSM editor URL template, normally fetched via `useAppConfig`.
     *  Threaded as a prop instead of read from a hook here so this
     *  component stays a pure MapLibre wrapper that's easy to test in
     *  isolation. The `{lat}`, `{lon}`, `{zoom}` placeholders are
     *  substituted by `mapLinks.osmEditorUrl`. */
    osmEditorUrlTemplate: string;
    /** Persisted measurement rows for this bbox (from `GET …/poi_focus_measurements`). */
    measurements: PoiFocusMeasurement[];
    measurementsLoading: boolean;
    measurementsError: string | null;
    onCreateMeasurement: (body: PoiFocusMeasurementWriteBody) => Promise<PoiFocusMeasurement>;
    onUpdateMeasurement: (
        measureId: string,
        body: PoiFocusMeasurementWriteBody,
    ) => Promise<PoiFocusMeasurement>;
    onDeleteMeasurement: (measureId: string) => Promise<void>;
    /** Reviewer flag from `PATCH /poi_pick` (matches overview map green dot). */
    poiPickCompleted: boolean;
    /** Reviewer flag from `PATCH /poi_pick` (red marker on the focus map);
     *  mutually exclusive with `poiPickCompleted` server-side. */
    poiPickRejected: boolean;
    /** Reason recorded with the rejection, or `null` when not rejected. */
    poiPickRejectedReason: PoiRejectionReason | null;
    /** True while any PATCH /poi_pick decision is in flight for this bbox
     *  (completed toggle or reject/unreject). */
    poiPickDecisionSaving?: boolean;
    onSetPoiPickCompleted: (completed: boolean) => void;
    onSetPoiPickRejected: (reason: PoiRejectionReason) => void;
    onSetPoiPickUnrejected: () => void;
}

/** Short labels for the reject-reason radio group + the "Rejected: …" badge. */
const REJECTION_REASON_LABELS: Record<PoiRejectionReason, string> = {
    no_imagery: 'No imagery',
    obsolete: 'Obsolete',
    other: 'Other',
};

const REJECTION_REASONS: readonly PoiRejectionReason[] = [
    'no_imagery',
    'obsolete',
    'other',
];

/** State for the right-click context menu: where to draw it (in
 *  canvas-relative CSS pixels) and which geo-coords to deeplink. */
interface MenuState {
    position: { x: number; y: number };
    point: MapPoint;
}

/** Snapshot used to detect unsaved edits (new line or PATCH on existing). */
interface MeasurementBaseline {
    /** `null` for a never-saved in-memory line. */
    serverId: string | null;
    coordinates: LngLatLike[];
    speedKmh: number;
    measurementPurpose: MeasurementPurpose;
    entranceType: EntranceType;
}

/** Unset select — not sent to the API until the user picks a value. */
type PurposeChoice = MeasurementPurpose | '';
type EntranceChoice = EntranceType | '';

const BUILDINGS_SOURCE = 'focus-buildings';
const BUILDING_CENTROIDS_SOURCE = 'focus-building-centroids';
const ENTRANCES_SOURCE = 'focus-entrances';
const PICKED_SOURCE = 'focus-picked';
const RING_SOURCE = 'focus-ring';
const MEASURE_SAVED_SOURCE = 'focus-measure-saved';
const MEASURE_SAVED_LINE = 'focus-measure-saved-line';
const MEASURE_SAVED_HIT = 'focus-measure-saved-hit';
const MEASURE_DRAFT_SOURCE = 'focus-measure-draft';
const MEASURE_DRAFT_LINE = 'focus-measure-draft-line';
/** Invisible thick line for hit-testing inserts between existing handles. */
const MEASURE_DRAFT_HIT = 'focus-measure-draft-hit';
/** Screen distance before a waypoint gesture is treated as a drag (vs click-remove). */
const WAYPOINT_DRAG_THRESHOLD_PX = 8;
const MEASURE_DRAFT_WAYPOINTS_SOURCE = 'focus-measure-draft-waypoints';
const MEASURE_DRAFT_WAYPOINTS_LAYER = 'focus-measure-draft-waypoints';

const BUILDINGS_FILL = 'focus-buildings-fill';
const BUILDINGS_LINE = 'focus-buildings-line';
const RING_LINE = 'focus-ring-line';
const ENTRANCES_LAYER = 'focus-entrances';
const BUILDING_CENTROIDS_LAYER = 'focus-building-centroids';
const PICKED_LAYER = 'focus-picked';

const FOCUS_LAYER_IDS = [
    BUILDINGS_FILL,
    BUILDINGS_LINE,
    RING_LINE,
    ENTRANCES_LAYER,
    BUILDING_CENTROIDS_LAYER,
    PICKED_LAYER,
    MEASURE_SAVED_LINE,
    MEASURE_SAVED_HIT,
    MEASURE_DRAFT_LINE,
    MEASURE_DRAFT_HIT,
    MEASURE_DRAFT_WAYPOINTS_LAYER,
];
const FOCUS_SOURCE_IDS = [
    BUILDINGS_SOURCE,
    BUILDING_CENTROIDS_SOURCE,
    ENTRANCES_SOURCE,
    PICKED_SOURCE,
    RING_SOURCE,
    MEASURE_SAVED_SOURCE,
    MEASURE_DRAFT_SOURCE,
    MEASURE_DRAFT_WAYPOINTS_SOURCE,
];

/** Arguments for painting persisted + draft measurement layers. */
interface MeasureLayerInstall {
    savedForDisplay: PoiFocusMeasurement[];
    draftPoints: LngLatLike[];
}

function copyLngLatPoints(coords: LngLatLike[]): LngLatLike[] {
    return coords.map((c) => {
        const p = c as [number, number];
        return [p[0], p[1]] as LngLatLike;
    });
}

function coordsEqual(a: LngLatLike[], b: LngLatLike[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const p = a[i] as [number, number];
        const q = b[i] as [number, number];
        if (p[0] !== q[0] || p[1] !== q[1]) return false;
    }
    return true;
}

/** GeoJSON `properties.index` on draft waypoint features (string after round-trip). */
function parseWaypointIndex(raw: unknown): number | null {
    const n =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Install the focus sources + layers, replacing any prior installation
 * so style swaps and data refreshes share the same code path. Caller
 * must ensure the style is loaded.
 */
function installFocusLayers(
    map: MapLibreMap,
    pickedPoi: Poi,
    focus: PoiFocusResult | undefined,
    measure: MeasureLayerInstall,
    poiPickCompleted: boolean,
    poiPickRejected: boolean,
) {
    for (const layer of FOCUS_LAYER_IDS) {
        if (map.getLayer(layer)) map.removeLayer(layer);
    }
    for (const source of FOCUS_SOURCE_IDS) {
        if (map.getSource(source)) map.removeSource(source);
    }

    const empty = { type: 'FeatureCollection' as const, features: [] };
    const buildings = focus ? toBuildingsCollection(focus) : empty;
    const buildingCentroids = focus ? toBuildingCentroidsCollection(focus) : empty;
    const entrances = focus ? toEntrancesCollection(focus) : empty;
    const ringFeature = focus
        ? toBufferRing(focus.center, focus.radius_m)
        : toBufferRing(pickedPoi.center, 0);
    const ring = { type: 'FeatureCollection' as const, features: [ringFeature] };

    map.addSource(BUILDINGS_SOURCE, { type: 'geojson', data: buildings });
    map.addSource(BUILDING_CENTROIDS_SOURCE, { type: 'geojson', data: buildingCentroids });
    map.addSource(ENTRANCES_SOURCE, { type: 'geojson', data: entrances });
    map.addSource(RING_SOURCE, { type: 'geojson', data: ring });
    map.addSource(PICKED_SOURCE, {
        type: 'geojson',
        data: toPickedPoiCollection(pickedPoi, poiPickCompleted, poiPickRejected),
    });

    if (measure.savedForDisplay.length > 0) {
        const fc = toSavedMeasurementsFeatureCollection(measure.savedForDisplay);
        map.addSource(MEASURE_SAVED_SOURCE, {
            type: 'geojson',
            data: fc,
            promoteId: 'measurement_id',
        });
        map.addLayer({
            id: MEASURE_SAVED_LINE,
            type: 'line',
            source: MEASURE_SAVED_SOURCE,
            paint: {
                'line-color': '#404040',
                'line-width': 3,
                'line-opacity': 0.55,
            },
        });
        map.addLayer({
            id: MEASURE_SAVED_HIT,
            type: 'line',
            source: MEASURE_SAVED_SOURCE,
            paint: {
                'line-color': '#000000',
                'line-width': 18,
                'line-opacity': 0,
            },
        });
    }

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
        id: BUILDING_CENTROIDS_LAYER,
        type: 'circle',
        source: BUILDING_CENTROIDS_SOURCE,
        paint: {
            'circle-radius': 3.5,
            'circle-color': '#64748b',
            'circle-opacity': 0.88,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1,
        },
    });
    map.addLayer({
        id: PICKED_LAYER,
        type: 'circle',
        source: PICKED_SOURCE,
        paint: {
            'circle-radius': 7,
            'circle-color': [
                'case',
                ['==', ['get', 'completed'], true],
                '#16a34a',
                ['==', ['get', 'rejected'], true],
                '#dc2626',
                '#f97316',
            ],
            'circle-opacity': 1,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2,
        },
    });

    // Draft measure is on top so handles/line receive clicks (not the building fill).
    if (measure.draftPoints.length >= 2) {
        map.addSource(MEASURE_DRAFT_SOURCE, {
            type: 'geojson',
            data: {
                type: 'FeatureCollection' as const,
                features: [
                    {
                        type: 'Feature' as const,
                        properties: {},
                        geometry: {
                            type: 'LineString' as const,
                            coordinates: measure.draftPoints as [number, number][],
                        },
                    },
                ],
            },
        });
        map.addLayer({
            id: MEASURE_DRAFT_LINE,
            type: 'line',
            source: MEASURE_DRAFT_SOURCE,
            paint: {
                'line-color': '#ea580c',
                'line-width': 4,
                'line-opacity': 0.8,
            },
        });
        map.addLayer({
            id: MEASURE_DRAFT_HIT,
            type: 'line',
            source: MEASURE_DRAFT_SOURCE,
            paint: {
                'line-color': '#000000',
                'line-width': 20,
                'line-opacity': 0,
            },
        });
    }

    if (measure.draftPoints.length > 0) {
        const waypointsFeature = {
            type: 'FeatureCollection' as const,
            features: measure.draftPoints.map((coord, i) => ({
                type: 'Feature' as const,
                properties: { index: i },
                geometry: {
                    type: 'Point' as const,
                    coordinates: coord as [number, number],
                },
            })),
        };
        map.addSource(MEASURE_DRAFT_WAYPOINTS_SOURCE, {
            type: 'geojson',
            data: waypointsFeature,
        });
        map.addLayer({
            id: MEASURE_DRAFT_WAYPOINTS_LAYER,
            type: 'circle',
            source: MEASURE_DRAFT_WAYPOINTS_SOURCE,
            paint: {
                // Slightly larger than visual stroke so handles are easier to grab.
                'circle-radius': 8,
                'circle-color': '#ea580c',
                'circle-opacity': 0.35,
                'circle-stroke-color': '#c2410c',
                'circle-stroke-width': 2,
                'circle-stroke-opacity': 0.95,
            },
        });
    }
}

/** Update draft line + waypoint GeoJSON without removing layers (keeps drag listeners alive). */
function syncDraftMeasureGeoJson(map: MapLibreMap, points: LngLatLike[]) {
    if (!map.isStyleLoaded()) return;

    const line = map.getSource(MEASURE_DRAFT_SOURCE);
    if (line && 'setData' in line && points.length >= 2) {
        (line as maplibregl.GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: points as [number, number][],
                    },
                },
            ],
        });
    }

    const wps = map.getSource(MEASURE_DRAFT_WAYPOINTS_SOURCE);
    if (wps && 'setData' in wps && points.length > 0) {
        (wps as maplibregl.GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: points.map((coord, i) => ({
                type: 'Feature' as const,
                properties: { index: i },
                geometry: {
                    type: 'Point' as const,
                    coordinates: coord as [number, number],
                },
            })),
        });
    }
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
    measurements,
    measurementsLoading,
    measurementsError,
    onCreateMeasurement,
    onUpdateMeasurement,
    onDeleteMeasurement,
    poiPickCompleted,
    poiPickRejected,
    poiPickRejectedReason,
    poiPickDecisionSaving = false,
    onSetPoiPickCompleted,
    onSetPoiPickRejected,
    onSetPoiPickUnrejected,
}: PoiFocusMapProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const focusRef = useRef(focus);
    const pickedRef = useRef(pickedPoi);
    const poiPickCompletedRef = useRef(poiPickCompleted);
    const poiPickRejectedRef = useRef(poiPickRejected);
    const measurementsRef = useRef(measurements);
    const layerInstallRef = useRef<MeasureLayerInstall>({
        savedForDisplay: [],
        draftPoints: [],
    });
    const allowAddVerticesRef = useRef(false);
    const isMeasuringRef = useRef(false);
    const selectMeasurementByIdRef = useRef<(id: string) => void>(() => {});
    /** `fitBounds` only when focus buffer identity changes — not on draft vertex count. */
    const lastFocusBoundsFitKeyRef = useRef<string>('');

    const [menuState, setMenuState] = useState<MenuState | null>(null);

    const [panelOpen, setPanelOpen] = useState(false);
    /** When true, the header started a *new* line (no DB id yet). */
    const [isMeasuring, setIsMeasuring] = useState(false);
    const [draftPoints, setDraftPoints] = useState<LngLatLike[]>([]);
    const draftPointsRef = useRef(draftPoints);
    /** Waypoint drag vs click-remove vs post-drag `click` suppression. */
    const measureGestureRef = useRef({
        suppressNextClick: false,
        waypointDragMoved: false,
        mousedownScreen: null as { x: number; y: number } | null,
    });
    const [measureSpeedInput, setMeasureSpeedInput] = useState(String(DEFAULT_WALKING_SPEED_KMH));
    const [measurementPurpose, setMeasurementPurpose] = useState<PurposeChoice>('');
    const [entranceType, setEntranceType] = useState<EntranceChoice>('');
    const [baseline, setBaseline] = useState<MeasurementBaseline | null>(null);
    const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
    const [mutationError, setMutationError] = useState<string | null>(null);

    useEffect(() => {
        focusRef.current = focus;
    });
    useEffect(() => {
        pickedRef.current = pickedPoi;
    });
    useEffect(() => {
        poiPickCompletedRef.current = poiPickCompleted;
    });
    useEffect(() => {
        poiPickRejectedRef.current = poiPickRejected;
    });

    const savedForLayer = useMemo(() => {
        if (panelOpen && selectedMeasurementId) {
            return measurements.filter((m) => m.id !== selectedMeasurementId);
        }
        return measurements;
    }, [measurements, panelOpen, selectedMeasurementId]);

    const parsedSpeed = useMemo(() => parseWalkingSpeedInput(measureSpeedInput), [measureSpeedInput]);
    const pathLengthM = calculatePathLength(draftPoints);
    const estimatedMinutes = estimateWalkingTimeMinutes(
        pathLengthM,
        parsedSpeed ?? DEFAULT_WALKING_SPEED_KMH,
    );

    const isDirty = useMemo(() => {
        if (baseline === null) {
            return (
                draftPoints.length > 0 ||
                measureSpeedInput.trim() !== String(DEFAULT_WALKING_SPEED_KMH) ||
                measurementPurpose !== '' ||
                entranceType !== ''
            );
        }
        const speedMatches = parsedSpeed !== null && parsedSpeed === baseline.speedKmh;
        return (
            !coordsEqual(draftPoints, baseline.coordinates) ||
            !speedMatches ||
            measurementPurpose !== baseline.measurementPurpose ||
            entranceType !== baseline.entranceType
        );
    }, [
        baseline,
        draftPoints,
        measureSpeedInput,
        parsedSpeed,
        measurementPurpose,
        entranceType,
    ]);

    const allowAddVertices = panelOpen && (isMeasuring || selectedMeasurementId !== null);
    useEffect(() => {
        allowAddVerticesRef.current = allowAddVertices;
    }, [allowAddVertices]);
    useLayoutEffect(() => {
        isMeasuringRef.current = isMeasuring;
    }, [isMeasuring]);

    /** Pick a saved line from the map only while the measure panel is closed. */
    const allowSavedPolylineClickSelectRef = useRef(true);
    useLayoutEffect(() => {
        allowSavedPolylineClickSelectRef.current = !panelOpen;
    }, [panelOpen]);

    useLayoutEffect(() => {
        draftPointsRef.current = draftPoints;
    }, [draftPoints]);

    useLayoutEffect(() => {
        measurementsRef.current = measurements;
    });

    useLayoutEffect(() => {
        layerInstallRef.current = {
            savedForDisplay: savedForLayer,
            draftPoints,
        };
    });

    useLayoutEffect(() => {
        selectMeasurementByIdRef.current = (id: string) => {
            const m = measurementsRef.current.find((x) => x.id === id);
            if (!m) return;
            setMutationError(null);
            setPanelOpen(true);
            setIsMeasuring(false);
            setSelectedMeasurementId(id);
            const coords = copyLngLatPoints(m.coordinates as LngLatLike[]);
            setDraftPoints(coords);
            setMeasureSpeedInput(String(m.walking_speed_kmh));
            setMeasurementPurpose(m.measurement_type);
            setEntranceType(m.entrance_type);
            setBaseline({
                serverId: id,
                coordinates: copyLngLatPoints(coords),
                speedKmh: m.walking_speed_kmh,
                measurementPurpose: m.measurement_type,
                entranceType: m.entrance_type,
            });
        };
    });

    const closePanelAndReset = () => {
        setPanelOpen(false);
        setIsMeasuring(false);
        setSelectedMeasurementId(null);
        setDraftPoints([]);
        setBaseline(null);
        setMeasureSpeedInput(String(DEFAULT_WALKING_SPEED_KMH));
        setMeasurementPurpose('');
        setEntranceType('');
        setMutationError(null);
    };

    const openNewMeasurementSession = () => {
        setMutationError(null);
        setPanelOpen(true);
        setIsMeasuring(true);
        setSelectedMeasurementId(null);
        setDraftPoints([]);
        setBaseline(null);
        setMeasureSpeedInput(String(DEFAULT_WALKING_SPEED_KMH));
        setMeasurementPurpose('');
        setEntranceType('');
    };

    const handleMeasureHeaderClick = () => {
        if (!panelOpen) {
            openNewMeasurementSession();
            return;
        }
        if (isDirty) handlePanelCancel();
        else closePanelAndReset();
    };

    const handlePanelCancel = () => {
        if (baseline === null) {
            setDraftPoints([]);
            setMeasureSpeedInput(String(DEFAULT_WALKING_SPEED_KMH));
            setMeasurementPurpose('');
            setEntranceType('');
        } else {
            setDraftPoints(copyLngLatPoints(baseline.coordinates));
            setMeasureSpeedInput(String(baseline.speedKmh));
            setMeasurementPurpose(baseline.measurementPurpose);
            setEntranceType(baseline.entranceType);
        }
        closePanelAndReset();
    };

    const handlePanelDismissX = () => {
        if (isDirty) handlePanelCancel();
        else closePanelAndReset();
    };

    const handleSave = async () => {
        if (!parsedSpeed || draftPoints.length < 2) return;
        if (!isMeasurementPurpose(measurementPurpose) || !isEntranceType(entranceType)) return;
        const map = mapRef.current;
        if (!map) {
            setMutationError('Map is not ready to save.');
            return;
        }
        setMutationError(null);
        const first = draftPoints[0] as [number, number];
        const poiFocusCenter = focus?.center ?? pickedPoi.center;
        const start = inferMeasurementStart(poiFocusCenter, focus?.entrances, focus?.buildings, {
            clickScreen: map.project({ lng: first[0], lat: first[1] }),
            project: (lon, lat) => map.project({ lng: lon, lat }),
            snapPx: ANCHOR_UI_GUARD_PX,
        });
        const body: PoiFocusMeasurementWriteBody = {
            coordinates: draftPoints as [number, number][],
            walking_speed_kmh: parsedSpeed,
            measurement_type: measurementPurpose,
            entrance_type: entranceType,
            start_origin: start.start_origin,
            start_osm_node_id: start.start_osm_node_id,
        };
        try {
            if (selectedMeasurementId === null) {
                const m = await onCreateMeasurement(body);
                setSelectedMeasurementId(m.id);
                setBaseline({
                    serverId: m.id,
                    coordinates: copyLngLatPoints(draftPoints),
                    speedKmh: parsedSpeed,
                    measurementPurpose: m.measurement_type,
                    entranceType: m.entrance_type,
                });
                setIsMeasuring(false);
            } else {
                const m = await onUpdateMeasurement(selectedMeasurementId, body);
                setBaseline({
                    serverId: selectedMeasurementId,
                    coordinates: copyLngLatPoints(draftPoints),
                    speedKmh: parsedSpeed,
                    measurementPurpose: m.measurement_type,
                    entranceType: m.entrance_type,
                });
            }
        } catch (err) {
            setMutationError(err instanceof Error ? err.message : String(err));
        }
    };

    const handleDelete = async () => {
        if (!selectedMeasurementId) return;
        setMutationError(null);
        try {
            await onDeleteMeasurement(selectedMeasurementId);
            closePanelAndReset();
        } catch (err) {
            setMutationError(err instanceof Error ? err.message : String(err));
        }
    };

    const triggeredRef = useRef(false);
    useEffect(() => {
        if (triggeredRef.current) return;
        if (focus !== undefined) return;
        triggeredRef.current = true;
        onLoadFocus(bbox.id);
    }, [bbox.id, focus, onLoadFocus]);

    const [radiusInput, setRadiusInput] = useState<string>(() =>
        String(focus?.radius_m ?? FOCUS_RADIUS_DEFAULT_M),
    );
    const [lastSyncedRadius, setLastSyncedRadius] = useState<number | undefined>(focus?.radius_m);
    if (focus && focus.radius_m !== lastSyncedRadius) {
        setLastSyncedRadius(focus.radius_m);
        setRadiusInput(String(focus.radius_m));
    }

    const parsedRadius = useMemo(() => parseFocusRadiusInput(radiusInput), [radiusInput]);
    const radiusUnchanged = focus !== undefined && parsedRadius === focus.radius_m;
    const submitDisabled = loading || parsedRadius === null || radiusUnchanged;
    const refreshDisabled =
        loading || focus === undefined || parsedRadius === null;

    const handleRadiusSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (submitDisabled || parsedRadius === null) return;
        onLoadFocus(bbox.id, parsedRadius);
    };

    const handleOverpassRefresh = () => {
        if (refreshDisabled || focus === undefined) return;
        void onLoadFocus(bbox.id, focus.radius_m, { refresh: true });
    };

    useEffect(() => {
        if (!containerRef.current) return;
        const initial = findBasemap(basemapId) ?? findBasemap(DEFAULT_BASEMAP_ID)!;
        const radiusM = focusRef.current?.radius_m ?? 200;
        const center = focusRef.current?.center ?? pickedRef.current.center;
        const map = new maplibregl.Map({
            container: containerRef.current,
            style: initial.style,
            center,
            zoom: 17,
            // Avoid zoom jumps while drawing (second click would otherwise zoom in).
            doubleClickZoom: false,
        });
        map.fitBounds(toFocusBounds(center, radiusM), {
            padding: 32,
            duration: 0,
            maxZoom: 19,
        });
        mapRef.current = map;

        map.on('style.load', () => {
            installFocusLayers(
                map,
                pickedRef.current,
                focusRef.current,
                layerInstallRef.current,
                poiPickCompletedRef.current,
                poiPickRejectedRef.current,
            );
        });
        map.on('error', (e) => console.error('[MapLibre]', e.error ?? e));
        map.on('contextmenu', (e) => {
            e.preventDefault();
            setMenuState({
                position: { x: e.point.x, y: e.point.y },
                point: { lat: e.lngLat.lat, lon: e.lngLat.lng, zoom: map.getZoom() },
            });
        });

        map.on('click', (e) => {
            const focusCenter = focusRef.current?.center;
            const pickedCenter = pickedRef.current.center;
            const poiFocusCenter: [number, number] = focusCenter ?? pickedCenter;
            const centerScreen = map.project({
                lng: poiFocusCenter[0],
                lat: poiFocusCenter[1],
            });
            const nearPoiFocusCenter =
                pixelDistance(e.point, centerScreen) <= ANCHOR_UI_GUARD_PX;
            const nearAnyEntrance = entranceCentersFromFocus(focusRef.current).some(
                ([lon, lat]) =>
                    pixelDistance(e.point, map.project([lon, lat])) <= ANCHOR_UI_GUARD_PX,
            );
            const nearAnyBuildingCentroid = buildingCentroidPointsForSnap(focusRef.current).some(
                ([lon, lat]) =>
                    pixelDistance(e.point, map.project([lon, lat])) <= ANCHOR_UI_GUARD_PX,
            );

            if (
                map.getLayer(MEASURE_SAVED_HIT) &&
                !nearPoiFocusCenter &&
                !nearAnyEntrance &&
                !nearAnyBuildingCentroid &&
                allowSavedPolylineClickSelectRef.current
            ) {
                const hit = map.queryRenderedFeatures(e.point, { layers: [MEASURE_SAVED_HIT] });
                if (hit.length > 0) {
                    const raw = hit[0].properties?.measurement_id;
                    const id = typeof raw === 'string' ? raw : raw != null ? String(raw) : '';
                    if (id) {
                        selectMeasurementByIdRef.current(id);
                        return;
                    }
                }
            }

            if (measureGestureRef.current.suppressNextClick) {
                measureGestureRef.current.suppressNextClick = false;
                return;
            }

            if (!allowAddVerticesRef.current) return;

            const screenProject = (lon: number, lat: number) => map.project({ lng: lon, lat });
            const snappedEntrance = snapClickToNearestAnchorPx(
                e.point,
                entranceCentersFromFocus(focusRef.current),
                screenProject,
                ANCHOR_UI_GUARD_PX,
            );
            const snappedBuilding =
                snappedEntrance === null
                    ? snapClickToNearestAnchorPx(
                          e.point,
                          buildingCentroidPointsForSnap(focusRef.current),
                          screenProject,
                          ANCHOR_UI_GUARD_PX,
                      )
                    : null;
            const anchorSnap = snappedEntrance ?? snappedBuilding;

            const firstVertexNewMeasurement =
                isMeasuringRef.current && draftPointsRef.current.length === 0;
            const snappedToFocus = snapClickToNearestAnchorPx(
                e.point,
                [poiFocusCenter],
                screenProject,
                ANCHOR_UI_GUARD_PX,
            );
            // First point: centroid wins over entrance/building when both are in range; later points still snap to anchors under the cursor.
            const centroidSnapFirst = firstVertexNewMeasurement
                ? snappedToFocus ?? anchorSnap
                : snappedToFocus;

            if (map.getLayer(MEASURE_DRAFT_WAYPOINTS_LAYER)) {
                const wps = map.queryRenderedFeatures(e.point, {
                    layers: [MEASURE_DRAFT_WAYPOINTS_LAYER],
                });
                if (wps.length > 0) {
                    const idx = parseWaypointIndex(wps[0].properties?.index);
                    if (idx !== null) {
                        setDraftPoints((prev) => prev.filter((_, i) => i !== idx));
                    }
                    return;
                }
            }

            if (map.getLayer(MEASURE_DRAFT_HIT)) {
                const lineHits = map.queryRenderedFeatures(e.point, {
                    layers: [MEASURE_DRAFT_HIT],
                });
                if (lineHits.length > 0) {
                    const ins = insertVertexAlongPolyline(draftPointsRef.current, e.lngLat);
                    if (ins) {
                        const pos = centroidSnapFirst ?? anchorSnap ?? ins.position;
                        setDraftPoints((prev) => {
                            const next = [...prev];
                            next.splice(ins.insertIndex, 0, pos);
                            return next;
                        });
                    }
                    return;
                }
            }

            const append =
                centroidSnapFirst ??
                anchorSnap ??
                ([e.lngLat.lng, e.lngLat.lat] as [number, number]);
            setDraftPoints((prev) => [...prev, append]);
        });

        return () => {
            map.remove();
            mapRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    const lastBasemapRef = useRef<BasemapId>(basemapId);
    useEffect(() => {
        if (lastBasemapRef.current === basemapId) return;
        lastBasemapRef.current = basemapId;
        const map = mapRef.current;
        if (!map) return;
        const basemap = findBasemap(basemapId);
        if (basemap) map.setStyle(basemap.style);
    }, [basemapId]);

    /** Full reinstall when focus, saved set, basemap, or draft *topology* changes — not every coordinate tweak. */
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const apply = () => {
            installFocusLayers(
                map,
                pickedPoi,
                focus,
                layerInstallRef.current,
                poiPickCompleted,
                poiPickRejected,
            );
            if (!focus) {
                lastFocusBoundsFitKeyRef.current = '';
                return;
            }
            // Re-framing the buffer on every new measurement vertex was resetting zoom;
            // only fit when centre or radius actually change.
            const fitKey = `${focus.center[0]},${focus.center[1]},${focus.radius_m}`;
            if (fitKey !== lastFocusBoundsFitKeyRef.current) {
                lastFocusBoundsFitKeyRef.current = fitKey;
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
    }, [focus, pickedPoi, savedForLayer, draftPoints.length, poiPickCompleted, poiPickRejected]);

    /** Keep draft paths in sync when only vertex coordinates change (drag / line snap). */
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const sync = () => {
            if (!map.isStyleLoaded()) return;
            syncDraftMeasureGeoJson(map, draftPoints);
        };
        if (map.isStyleLoaded()) {
            sync();
            return;
        }
        map.once('idle', sync);
        return () => {
            map.off('idle', sync);
        };
    }, [draftPoints]);

    /** Drag draft measurement vertices on the waypoint circle layer. */
    useEffect(() => {
        const map = mapRef.current;
        if (!map || draftPoints.length === 0) return;

        const dragIndexRef = { current: null as number | null };

        const onLayerMouseDown = (e: maplibregl.MapLayerMouseEvent) => {
            if (!allowAddVerticesRef.current) return;
            e.preventDefault();
            const idx = parseWaypointIndex(e.features?.[0]?.properties?.index);
            if (idx === null) return;
            measureGestureRef.current.mousedownScreen = { x: e.point.x, y: e.point.y };
            measureGestureRef.current.waypointDragMoved = false;
            dragIndexRef.current = idx;
            map.dragPan.disable();
            map.getCanvas().style.cursor = 'grabbing';
        };

        const onMapMouseMove = (e: maplibregl.MapMouseEvent) => {
            const i = dragIndexRef.current;
            if (i === null) return;
            const ms = measureGestureRef.current.mousedownScreen;
            if (ms) {
                const dx = e.point.x - ms.x;
                const dy = e.point.y - ms.y;
                const th = WAYPOINT_DRAG_THRESHOLD_PX;
                if (dx * dx + dy * dy >= th * th) {
                    measureGestureRef.current.waypointDragMoved = true;
                }
            }
            const { lng, lat } = e.lngLat;
            setDraftPoints((prev) => {
                if (i >= prev.length) return prev;
                const next = [...prev];
                next[i] = [lng, lat];
                return next;
            });
        };

        const endDrag = () => {
            if (dragIndexRef.current === null) return;
            const moved = measureGestureRef.current.waypointDragMoved;
            dragIndexRef.current = null;
            measureGestureRef.current.mousedownScreen = null;
            measureGestureRef.current.waypointDragMoved = false;
            if (moved) measureGestureRef.current.suppressNextClick = true;
            map.dragPan.enable();
            map.getCanvas().style.cursor = '';
        };

        const onLayerMouseEnter = () => {
            if (allowAddVerticesRef.current && dragIndexRef.current === null) {
                map.getCanvas().style.cursor = 'grab';
            }
        };

        const onLayerMouseLeave = () => {
            if (dragIndexRef.current === null) {
                map.getCanvas().style.cursor = '';
            }
        };

        let attached = false;

        const detach = () => {
            if (!attached) return;
            attached = false;
            map.off('mousedown', MEASURE_DRAFT_WAYPOINTS_LAYER, onLayerMouseDown);
            map.off('mousemove', onMapMouseMove);
            map.off('mouseup', endDrag);
            map.off('mouseenter', MEASURE_DRAFT_WAYPOINTS_LAYER, onLayerMouseEnter);
            map.off('mouseleave', MEASURE_DRAFT_WAYPOINTS_LAYER, onLayerMouseLeave);
            window.removeEventListener('mouseup', endDrag);
            endDrag();
        };

        const attach = () => {
            if (!map.isStyleLoaded() || !map.getLayer(MEASURE_DRAFT_WAYPOINTS_LAYER)) return;
            attached = true;
            map.on('mousedown', MEASURE_DRAFT_WAYPOINTS_LAYER, onLayerMouseDown);
            map.on('mousemove', onMapMouseMove);
            map.on('mouseup', endDrag);
            map.on('mouseenter', MEASURE_DRAFT_WAYPOINTS_LAYER, onLayerMouseEnter);
            map.on('mouseleave', MEASURE_DRAFT_WAYPOINTS_LAYER, onLayerMouseLeave);
            window.addEventListener('mouseup', endDrag);
        };

        const run = () => {
            detach();
            attach();
        };

        run();
        if (!attached) {
            map.once('idle', run);
        }

        return () => {
            map.off('idle', run);
            detach();
        };
    }, [draftPoints.length, allowAddVertices, focus, pickedPoi, savedForLayer, basemapId]);

    const typesChosen =
        isMeasurementPurpose(measurementPurpose) && isEntranceType(entranceType);
    const saveDisabled =
        !isDirty ||
        draftPoints.length < 2 ||
        parsedSpeed === null ||
        !typesChosen ||
        measurementsLoading;
    const deleteDisabled = selectedMeasurementId === null || measurementsLoading;
    const cancelVisible = isDirty;
    const closeVisible = !isDirty;

    return (
        <div className="poi-focus-map">
            <header className="poi-focus-map__header">
                <button type="button" className="poi-focus-map__back" onClick={onBack}>
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
                    <button
                        type="button"
                        disabled={refreshDisabled}
                        onClick={handleOverpassRefresh}
                        title="Re-query Overpass at the current radius (after OSM edits)"
                    >
                        Refresh
                    </button>
                    <span id="poi-focus-radius-help" className="poi-focus-map__radius-help">
                        {FOCUS_RADIUS_MIN_M}–{FOCUS_RADIUS_MAX_M} m
                    </span>
                </form>

                <button
                    type="button"
                    className="poi-focus-map__measure-btn"
                    onClick={handleMeasureHeaderClick}
                >
                    {panelOpen ? 'Done' : 'Measure'}
                </button>
                <label className="poi-focus-map__completed">
                    <input
                        type="checkbox"
                        checked={poiPickCompleted}
                        disabled={poiPickDecisionSaving}
                        onChange={(e) => onSetPoiPickCompleted(e.target.checked)}
                    />{' '}
                    POI completed
                </label>
                {poiPickRejected ? (
                    <div className="poi-focus-map__reject-poi poi-focus-map__reject-poi--rejected">
                        <span className="poi-focus-map__reject-poi__badge">
                            Rejected
                            {poiPickRejectedReason
                                ? `: ${REJECTION_REASON_LABELS[poiPickRejectedReason]}`
                                : ''}
                        </span>
                        <button
                            type="button"
                            className="poi-focus-map__reject-poi__undo"
                            disabled={poiPickDecisionSaving}
                            onClick={() => onSetPoiPickUnrejected()}
                        >
                            Undo
                        </button>
                    </div>
                ) : (
                    <RejectPoiHeaderForm
                        disabled={poiPickDecisionSaving}
                        onReject={onSetPoiPickRejected}
                    />
                )}
            </header>

            <div ref={containerRef} className="poi-focus-map__canvas" data-testid="poi-focus-map">
                <MapContextMenu
                    position={menuState?.position ?? null}
                    items={menuItems}
                    onDismiss={() => setMenuState(null)}
                />

                {panelOpen && (
                    <div
                        className="measure-panel"
                        onPointerDownCapture={(e) => e.stopPropagation()}
                    >
                        <div className="measure-panel__header">
                            <strong>Measurement</strong>
                            <button type="button" onClick={handlePanelDismissX} aria-label="Close panel">
                                ✕
                            </button>
                        </div>
                        <div className="measure-panel__body">
                            {measurementsError && (
                                <p className="measure-panel__error" role="alert">
                                    {measurementsError}
                                </p>
                            )}
                            {mutationError && (
                                <p className="measure-panel__error" role="alert">
                                    {mutationError}
                                </p>
                            )}
                            <div>
                                <strong>{pathLengthM}</strong> m
                            </div>
                            <div>
                                <label htmlFor="measure-purpose-select">Type</label>
                                <select
                                    id="measure-purpose-select"
                                    value={measurementPurpose}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setMeasurementPurpose(v === '' ? '' : (v as MeasurementPurpose));
                                    }}
                                >
                                    <option value="">—</option>
                                    {MEASUREMENT_PURPOSES.map((v) => (
                                        <option key={v} value={v}>
                                            {MEASUREMENT_PURPOSE_LABELS[v]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="measure-entrance-select">Entrance type</label>
                                <select
                                    id="measure-entrance-select"
                                    value={entranceType}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setEntranceType(v === '' ? '' : (v as EntranceType));
                                    }}
                                >
                                    <option value="">—</option>
                                    {ENTRANCE_TYPES.map((v) => (
                                        <option key={v} value={v}>
                                            {ENTRANCE_TYPE_LABELS[v]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label>
                                    Speed:{' '}
                                    <input
                                        type="number"
                                        step="0.1"
                                        min={0.5}
                                        max={10}
                                        value={measureSpeedInput}
                                        onChange={(e) => setMeasureSpeedInput(e.target.value)}
                                        style={{ width: '4rem' }}
                                    />{' '}
                                    km/h
                                </label>
                            </div>
                            <div>
                                ≈ <strong>{estimatedMinutes}</strong> min ({Math.round(estimatedMinutes * 60)}{' '}
                                sec) walk
                            </div>
                            <div className="measure-panel__actions">
                                <button type="button" disabled={saveDisabled} onClick={() => void handleSave()}>
                                    Save
                                </button>
                                <button
                                    type="button"
                                    disabled={deleteDisabled}
                                    onClick={() => void handleDelete()}
                                >
                                    Delete
                                </button>
                                {cancelVisible && (
                                    <button type="button" onClick={handlePanelCancel}>
                                        Cancel
                                    </button>
                                )}
                                {closeVisible && (
                                    <button type="button" onClick={closePanelAndReset}>
                                        Close
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {loading && <p className="poi-focus-map__status">Loading buildings &amp; entrances…</p>}
            {error && (
                <p className="poi-focus-map__error" role="alert">
                    {error}
                </p>
            )}
            {!loading &&
                !error &&
                focus &&
                focus.buildings.features.length === 0 &&
                focus.entrances.features.length === 0 && (
                    <p className="poi-focus-map__status">
                        Overpass returned no buildings or entrances inside the buffer.
                    </p>
                )}
        </div>
    );
}

/** Reject-reason radio + submit button for the focus-map header. Owns
 *  its own pending selection so it resets on (un)mount when the parent
 *  flips between rejected and pending — no `useEffect` sync. */
function RejectPoiHeaderForm({
    disabled,
    onReject,
}: {
    disabled: boolean;
    onReject: (reason: PoiRejectionReason) => void;
}) {
    const [pendingReason, setPendingReason] = useState<PoiRejectionReason | ''>('');
    return (
        <form
            className="poi-focus-map__reject-poi"
            onSubmit={(e) => {
                e.preventDefault();
                if (pendingReason !== '') onReject(pendingReason);
            }}
        >
            <span className="poi-focus-map__reject-poi__legend">Reject:</span>
            {REJECTION_REASONS.map((r) => (
                <label key={r} className="poi-focus-map__reject-poi__reason">
                    <input
                        type="radio"
                        name="poi-focus-reject-reason"
                        value={r}
                        checked={pendingReason === r}
                        disabled={disabled}
                        onChange={() => setPendingReason(r)}
                    />{' '}
                    {REJECTION_REASON_LABELS[r]}
                </label>
            ))}
            <button
                type="submit"
                className="poi-focus-map__reject-poi__submit"
                disabled={pendingReason === '' || disabled}
            >
                Reject POI
            </button>
        </form>
    );
}

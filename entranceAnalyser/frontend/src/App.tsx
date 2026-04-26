import { useCallback, useMemo, useState } from 'react';

import { BasemapToggle } from './BasemapToggle';
import { CustomCentroidModal } from './CustomCentroidModal';
import { BASEMAPS, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { KeptBboxesMap } from './keptBboxes/KeptBboxesMap';
import { PoiFocusMap } from './keptBboxes/PoiFocusMap';
import { useKeptBboxes } from './keptBboxes/useKeptBboxes';
import { usePoiFocus } from './keptBboxes/usePoiFocus';
import { usePoiFocusMeasurements } from './keptBboxes/usePoiFocusMeasurements';
import { usePoiPicks } from './keptBboxes/usePoiPicks';
import { MapView } from './MapView';
import { SamplingPanel } from './SamplingPanel';
import { submitDecision, type Bbox, type Decision } from './api';
import { useAppConfig } from './useAppConfig';
import { useSampling } from './useSampling';

/** Fallback OSM editor URL used while the backend config is still
 *  loading or if the request fails. Mirrors `DEFAULT_OSM_EDITOR_URL`
 *  in the backend so the frontend behaviour is identical to a fresh
 *  install with no `OSM_EDITOR_URL` env var set. */
const FALLBACK_OSM_EDITOR_URL = 'https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}';

type AppView = 'sampling' | 'kept' | 'focus';

const REMOVE_KEPT_CONFIRM =
    'Remove this cell from kept? Cached POI picks, focus results, and measurements will be deleted.';

function App() {
    const [view, setView] = useState<AppView>('sampling');
    const [focusBboxId, setFocusBboxId] = useState<string | null>(null);
    const [removingKeptId, setRemovingKeptId] = useState<string | null>(null);
    const [basemapId, setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP_ID);
    const [customCentroidOpen, setCustomCentroidOpen] = useState(false);
    const kept = useKeptBboxes();
    const poiPicks = usePoiPicks();
    const submitWithReload = useMemo(
        () => async (bbox: Bbox, decision: Decision) => {
            const reply = await submitDecision(bbox, decision);
            if (decision === 'keep') {
                await Promise.all([kept.reload(), poiPicks.reload()]);
            }
            return reply;
        },
        [kept.reload, poiPicks.reload],
    );
    const {
        bbox,
        keptCount,
        status,
        error,
        strategy,
        setStrategy,
        decide,
        skip,
        applyCustomCentroid,
        applyCustomOsm,
    } = useSampling({ submit: submitWithReload });
    const poiFocus = usePoiFocus();
    const focusMeasurements = usePoiFocusMeasurements(focusBboxId);
    const appConfig = useAppConfig();

    /**
     * Open the focus view for one bbox: pin the active id and trigger
     * a `loadFocus` so the map has data ready (or already cached) by
     * the time MapLibre finishes its mount. Mounted PoiFocusMap will
     * also re-trigger if the cache was cold and the load failed mid-flight.
     */
    const handleOpenFocus = useCallback(
        (bboxId: string) => {
            setFocusBboxId(bboxId);
            setView('focus');
            void poiFocus.loadFocus(bboxId);
        },
        [poiFocus],
    );

    const handleRemoveKept = useCallback(
        async (bboxId: string) => {
            if (!window.confirm(REMOVE_KEPT_CONFIRM)) return;
            setRemovingKeptId(bboxId);
            try {
                await kept.removeKept(bboxId);
                poiPicks.removePickForBbox(bboxId);
                poiFocus.dropFocus(bboxId);
                if (focusBboxId === bboxId) {
                    setFocusBboxId(null);
                    setView('kept');
                }
            } finally {
                setRemovingKeptId(null);
            }
        },
        [kept, poiPicks, poiFocus, focusBboxId],
    );

    const focusBbox = focusBboxId
        ? kept.keptBboxes.find((b) => b.id === focusBboxId) ?? null
        : null;
    const focusPick = focusBboxId ? poiPicks.picks[focusBboxId] : undefined;
    const focusPoi = focusPick?.poi;

    return (
        <div className="app">
            {view !== 'focus' && (
                <nav className="app-tabs" aria-label="Views">
                    <button
                        type="button"
                        aria-pressed={view === 'sampling'}
                        onClick={() => setView('sampling')}
                    >
                        Sampling
                    </button>
                    <button
                        type="button"
                        aria-pressed={view === 'kept'}
                        onClick={() => setView('kept')}
                    >
                        Kept bboxes
                    </button>
                </nav>
            )}

            {view === 'sampling' && (
                <>
                    <MapView basemapId={basemapId} bbox={bbox} />
                    <BasemapToggle
                        basemaps={BASEMAPS}
                        activeId={basemapId}
                        onChange={setBasemapId}
                    />
                    <SamplingPanel
                        bbox={bbox}
                        keptCount={kept.status === 'idle' ? kept.keptBboxes.length : keptCount}
                        status={status}
                        error={error}
                        strategy={strategy}
                        onStrategyChange={setStrategy}
                        onDecide={decide}
                        onSkip={skip}
                        onOpenCustomCentroid={() => setCustomCentroidOpen(true)}
                    />
                    <CustomCentroidModal
                        open={customCentroidOpen}
                        onClose={() => setCustomCentroidOpen(false)}
                        busy={status === 'loading'}
                        onApplyLatLon={applyCustomCentroid}
                        onApplyOsmRef={applyCustomOsm}
                    />
                </>
            )}

            {view === 'kept' && (
                <>
                    <KeptBboxesMap
                        keptBboxes={kept.keptBboxes}
                        basemapId={basemapId}
                        status={kept.status}
                        error={kept.error}
                        picks={poiPicks.picks}
                        picking={poiPicks.picking}
                        savingPickCompleted={poiPicks.savingCompleted}
                        onPickPoi={poiPicks.pick}
                        onSetPickCompleted={(id, completed) => {
                            void poiPicks.setPickCompleted(id, completed);
                        }}
                        onOpenFocus={handleOpenFocus}
                        openingFocus={poiFocus.loading}
                        onRemoveFromKept={handleRemoveKept}
                        removingKeptBboxId={removingKeptId}
                    />
                    <BasemapToggle
                        basemaps={BASEMAPS}
                        activeId={basemapId}
                        onChange={setBasemapId}
                    />
                </>
            )}

            {view === 'focus' && focusBbox && focusPoi && focusPick && (
                <>
                    <PoiFocusMap
                        // Re-mount when the user pivots between bboxes so
                        // MapLibre re-frames the buffer ring at the right
                        // centre instead of pan-animating across the world.
                        key={focusBbox.id}
                        bbox={focusBbox}
                        pickedPoi={focusPoi}
                        poiPickCompleted={focusPick.completed}
                        poiPickCompletedSaving={poiPicks.savingCompleted.has(focusBbox.id)}
                        onSetPoiPickCompleted={(completed) => {
                            void poiPicks.setPickCompleted(focusBbox.id, completed);
                        }}
                        onRemoveFromKept={() => void handleRemoveKept(focusBbox.id)}
                        removeFromKeptBusy={removingKeptId === focusBbox.id}
                        focus={poiFocus.focuses[focusBbox.id]}
                        loading={poiFocus.loading.has(focusBbox.id)}
                        error={poiFocus.error}
                        basemapId={basemapId}
                        onBack={() => setView('kept')}
                        onLoadFocus={poiFocus.loadFocus}
                        osmEditorUrlTemplate={
                            appConfig.config?.osm_editor_url ?? FALLBACK_OSM_EDITOR_URL
                        }
                        measurements={focusMeasurements.measurements}
                        measurementsLoading={focusMeasurements.loading}
                        measurementsError={focusMeasurements.error}
                        onCreateMeasurement={focusMeasurements.create}
                        onUpdateMeasurement={focusMeasurements.update}
                        onDeleteMeasurement={focusMeasurements.remove}
                    />
                    <BasemapToggle
                        basemaps={BASEMAPS}
                        activeId={basemapId}
                        onChange={setBasemapId}
                    />
                </>
            )}

            {view === 'focus' && (!focusBbox || !focusPoi) && (
                <div className="poi-focus-map">
                    <header className="poi-focus-map__header">
                        <button
                            type="button"
                            className="poi-focus-map__back"
                            onClick={() => setView('kept')}
                        >
                            ← Back
                        </button>
                        <div className="poi-focus-map__title">Focus map unavailable</div>
                    </header>
                    <p className="poi-focus-map__status">
                        The selected bbox or its picked POI is no longer in memory. Reopen
                        the focus map from the popup.
                    </p>
                </div>
            )}
        </div>
    );
}

export default App;

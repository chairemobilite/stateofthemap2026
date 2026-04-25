import { useCallback, useState } from 'react';

import { BasemapToggle } from './BasemapToggle';
import { BASEMAPS, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { KeptBboxesMap } from './keptBboxes/KeptBboxesMap';
import { PoiFocusMap } from './keptBboxes/PoiFocusMap';
import { useKeptBboxes } from './keptBboxes/useKeptBboxes';
import { usePoiFocus } from './keptBboxes/usePoiFocus';
import { usePoiPicks } from './keptBboxes/usePoiPicks';
import { MapView } from './MapView';
import { SamplingPanel } from './SamplingPanel';
import { useSampling } from './useSampling';

type AppView = 'sampling' | 'kept' | 'focus';

function App() {
    const [view, setView] = useState<AppView>('sampling');
    const [focusBboxId, setFocusBboxId] = useState<string | null>(null);
    const [basemapId, setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP_ID);
    const { bbox, keptCount, status, error, strategy, setStrategy, decide, skip } = useSampling();
    const kept = useKeptBboxes();
    const poiPicks = usePoiPicks();
    const poiFocus = usePoiFocus();

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

    const focusBbox = focusBboxId
        ? kept.keptBboxes.find((b) => b.id === focusBboxId) ?? null
        : null;
    const focusPoi = focusBboxId ? poiPicks.picks[focusBboxId] : undefined;

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
                        keptCount={keptCount}
                        status={status}
                        error={error}
                        strategy={strategy}
                        onStrategyChange={setStrategy}
                        onDecide={decide}
                        onSkip={skip}
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
                        onPickPoi={poiPicks.pick}
                        onOpenFocus={handleOpenFocus}
                        openingFocus={poiFocus.loading}
                    />
                    <BasemapToggle
                        basemaps={BASEMAPS}
                        activeId={basemapId}
                        onChange={setBasemapId}
                    />
                </>
            )}

            {view === 'focus' && focusBbox && focusPoi && (
                <>
                    <PoiFocusMap
                        // Re-mount when the user pivots between bboxes so
                        // MapLibre re-frames the buffer ring at the right
                        // centre instead of pan-animating across the world.
                        key={focusBbox.id}
                        bbox={focusBbox}
                        pickedPoi={focusPoi}
                        focus={poiFocus.focuses[focusBbox.id]}
                        loading={poiFocus.loading.has(focusBbox.id)}
                        error={poiFocus.error}
                        basemapId={basemapId}
                        onBack={() => setView('kept')}
                        onLoadFocus={poiFocus.loadFocus}
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

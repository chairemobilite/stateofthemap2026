import { useState } from 'react';

import { BasemapToggle } from './BasemapToggle';
import { BASEMAPS, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { KeptBboxesMap } from './keptBboxes/KeptBboxesMap';
import { useKeptBboxes } from './keptBboxes/useKeptBboxes';
import { MapView } from './MapView';
import { SamplingPanel } from './SamplingPanel';
import { useSampling } from './useSampling';

type AppView = 'sampling' | 'kept';

function App() {
    const [view, setView] = useState<AppView>('sampling');
    const [basemapId, setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP_ID);
    const { bbox, keptCount, status, error, strategy, setStrategy, decide, skip } = useSampling();
    const kept = useKeptBboxes();

    return (
        <div className="app">
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

            {view === 'sampling' ? (
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
            ) : (
                <>
                    <KeptBboxesMap
                        keptBboxes={kept.keptBboxes}
                        basemapId={basemapId}
                        status={kept.status}
                        error={kept.error}
                    />
                    <BasemapToggle
                        basemaps={BASEMAPS}
                        activeId={basemapId}
                        onChange={setBasemapId}
                    />
                </>
            )}
        </div>
    );
}

export default App;

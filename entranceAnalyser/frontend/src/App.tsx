import { useState } from 'react';

import type { KeptBbox } from './api';
import { BasemapToggle } from './BasemapToggle';
import { BASEMAPS, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { KeptBboxesView } from './keptBboxes/KeptBboxesView';
import { MapView } from './MapView';
import { SamplingPanel } from './SamplingPanel';
import { useSampling } from './useSampling';

type AppView = 'sampling' | 'kept';

// Temporary placeholder so reviewers can click through the kept-bboxes
// screen without a running backend. Replaced by `useKeptBboxes()` in the
// next commit on this branch.
const DEMO_KEPT_BBOXES: KeptBbox[] = [
    {
        id: 'demo0001-0000-0000-0000-000000000001',
        west: -73.6,
        south: 45.5,
        east: -73.5,
        north: 45.6,
        center: [-73.55, 45.55],
        cell_size_km: 10,
        population: 12_500,
        density_per_km2: 125,
        max_density_ratio: 0.05,
        built_volume: 500_000,
        max_built_volume_ratio: 0.25,
        kept_at: '2026-04-23T12:00:00Z',
    },
    {
        id: 'demo0002-0000-0000-0000-000000000002',
        west: 2.3,
        south: 48.85,
        east: 2.4,
        north: 48.95,
        center: [2.35, 48.9],
        cell_size_km: 10,
        population: 85_000,
        density_per_km2: 850,
        max_density_ratio: 0.32,
        built_volume: 4_200_000,
        max_built_volume_ratio: 0.78,
        kept_at: '2026-04-24T09:30:00Z',
    },
];

function App() {
    const [view, setView] = useState<AppView>('sampling');
    const [basemapId, setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP_ID);
    const { bbox, keptCount, status, error, strategy, setStrategy, decide, skip } = useSampling();

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
                <KeptBboxesView keptBboxes={DEMO_KEPT_BBOXES} status="idle" error={null} />
            )}
        </div>
    );
}

export default App;

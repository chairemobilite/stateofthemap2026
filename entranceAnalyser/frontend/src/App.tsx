import { useState } from 'react';

import { BasemapToggle } from './BasemapToggle';
import { BASEMAPS, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { MapView } from './MapView';
import { SamplingPanel } from './SamplingPanel';
import { useSampling } from './useSampling';

function App() {
    const [basemapId, setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP_ID);
    const { bbox, keptCount, status, error, strategy, setStrategy, decide, skip } = useSampling();

    return (
        <div className="app">
            <MapView basemapId={basemapId} bbox={bbox} />
            <BasemapToggle basemaps={BASEMAPS} activeId={basemapId} onChange={setBasemapId} />
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
        </div>
    );
}

export default App;

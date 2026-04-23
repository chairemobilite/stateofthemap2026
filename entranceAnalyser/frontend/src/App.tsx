import { useState } from 'react';

import { BasemapToggle } from './BasemapToggle';
import { BASEMAPS, DEFAULT_BASEMAP_ID, type BasemapId } from './basemaps';
import { MapView } from './MapView';

function App() {
    const [basemapId, setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP_ID);

    return (
        <div className="app">
            <MapView basemapId={basemapId} bbox={null} />
            <BasemapToggle basemaps={BASEMAPS} activeId={basemapId} onChange={setBasemapId} />
        </div>
    );
}

export default App;

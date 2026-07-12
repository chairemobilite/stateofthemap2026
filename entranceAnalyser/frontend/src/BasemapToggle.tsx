/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Floating button group for switching between basemaps.
//!
//! Pure presentational component: the parent owns the active id and passes
//! it in as a prop, which keeps this file trivial to unit test in jsdom.

import type { Basemap, BasemapId } from './basemaps';

export interface BasemapToggleProps {
    basemaps: readonly Basemap[];
    activeId: BasemapId;
    onChange: (id: BasemapId) => void;
}

export function BasemapToggle({ basemaps, activeId, onChange }: BasemapToggleProps) {
    return (
        <div className="basemap-toggle" role="group" aria-label="Basemap">
            {basemaps.map((basemap) => {
                const isActive = basemap.id === activeId;
                return (
                    <button
                        key={basemap.id}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => onChange(basemap.id)}
                    >
                        {basemap.label}
                    </button>
                );
            })}
        </div>
    );
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Editable reviewer-facing POI name (`PATCH /poi_pick { poi_name }`).

import { useEffect, useState } from 'react';

import type { Poi } from '../api';
import { poiOsmIdFallback } from './poiDisplayName';

export interface PoiNameInputProps {
    poi: Poi;
    disabled?: boolean;
    /** Persist on blur / Enter. Pass `null` to clear the stored name. */
    onCommit: (name: string | null) => void;
    /** Optional class for table vs panel layouts. */
    className?: string;
}

/**
 * Text field bound to `poi.tags.name`, with osm-id placeholder when empty.
 *
 * @param props - POI row, disabled flag, and commit handler.
 */
export function PoiNameInput({
    poi,
    disabled = false,
    onCommit,
    className = 'poi-name-input',
}: PoiNameInputProps) {
    const stored = poi.tags['name'] ?? '';
    const [draft, setDraft] = useState(stored);

    useEffect(() => {
        setDraft(poi.tags['name'] ?? '');
    }, [poi.tags['name'], poi.osm_id]);

    const commit = () => {
        const trimmed = draft.trim();
        const current = poi.tags['name'] ?? '';
        if (trimmed === current) return;
        onCommit(trimmed || null);
    };

    return (
        <input
            type="text"
            className={className}
            value={draft}
            placeholder={poiOsmIdFallback(poi)}
            disabled={disabled}
            aria-label="POI name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.currentTarget.blur();
                }
            }}
        />
    );
}

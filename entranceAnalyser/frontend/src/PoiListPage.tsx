/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Table of every started or completed POI pick, with World / Quebec scopes.

import { useMemo, useState } from 'react';

import type { KeptBbox, PlaceType, PoiPickEntry } from './api';
import { osmEditorUrlForPoi } from './keptBboxes/mapLinks';
import { PlaceTypeSelect } from './keptBboxes/PlaceTypeSelect';
import {
    buildPoiListRows,
    filterPoiListRowsByScope,
    poiDisplayName,
    type PoiListScope,
} from './keptBboxes/poiListRows';
import { StatusPill } from './keptBboxes/StatusPill';

export interface PoiListPageProps {
    keptBboxes: KeptBbox[];
    picks: Record<string, PoiPickEntry>;
    /** Bbox ids with a PATCH /poi_pick in flight. */
    savingDecision: Set<string>;
    onSetPickPlaceType: (bboxId: string, placeType: PlaceType | null) => void;
    /** Open the focus map for one kept bbox (wired from `App`). */
    onOpenPoiFocus?: (bboxId: string) => void;
    /** iD editor URL template from `GET /api/config`. */
    osmEditorUrlTemplate: string;
    /** Loading state for kept bboxes and/or picks. */
    loading?: boolean;
    error?: string | null;
}

/**
 * Full-page POI inventory with World and Quebec sub-tabs.
 *
 * @param props - Kept cells, cached picks, and mutation handlers from `App`.
 */
export function PoiListPage({
    keptBboxes,
    picks,
    savingDecision,
    onSetPickPlaceType,
    onOpenPoiFocus,
    osmEditorUrlTemplate,
    loading = false,
    error = null,
}: PoiListPageProps) {
    const [scope, setScope] = useState<PoiListScope>('quebec');
    const allRows = useMemo(() => buildPoiListRows(keptBboxes, picks), [keptBboxes, picks]);
    const rows = useMemo(() => filterPoiListRowsByScope(allRows, scope), [allRows, scope]);
    const quebecCount = useMemo(() => allRows.filter((r) => r.inQuebec).length, [allRows]);
    const worldCount = allRows.length - quebecCount;

    return (
        <div className="poi-list-page measurement-stats-page">
            <header className="measurement-stats-page__header">
                <h1 className="measurement-stats-page__title">POI picks</h1>
                <p className="measurement-stats-page__intro">
                    Started and completed POI picks across kept cells. Use the editor link to
                    open iD on the feature, and set the place type when the autodetected category
                    is wrong.
                </p>
                <nav className="poi-list-page__tabs" aria-label="Geographic scope">
                    <button
                        type="button"
                        aria-pressed={scope === 'world'}
                        onClick={() => setScope('world')}
                    >
                        World ({worldCount})
                    </button>
                    <button
                        type="button"
                        aria-pressed={scope === 'quebec'}
                        onClick={() => setScope('quebec')}
                    >
                        Québec ({quebecCount})
                    </button>
                </nav>
            </header>

            {loading && <p className="measurement-stats-page__status">Loading POI picks…</p>}
            {error && (
                <p className="measurement-stats-page__error" role="alert">
                    {error}
                </p>
            )}

            <div className="measurement-stats-page__body">
                <section className="measurement-stats__section">
                    {rows.length === 0 ? (
                        <p className="measurement-stats__empty">
                            No started or completed POIs in this scope yet.
                        </p>
                    ) : (
                        <div className="measurement-stats__scroll">
                            <table className="measurement-stats__table poi-list-page__table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Status</th>
                                        <th>Place type</th>
                                        <th>Edit</th>
                                        <th>Focus</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map(({ bbox, poi, pick, status }) => {
                                        const editUrl = osmEditorUrlForPoi(osmEditorUrlTemplate, poi);
                                        const saving = savingDecision.has(bbox.id);
                                        return (
                                            <tr key={bbox.id}>
                                                <td>
                                                    <span className="poi-list-page__name">
                                                        {poiDisplayName(poi)}
                                                    </span>
                                                    <span className="poi-list-page__meta">
                                                        {poi.osm_type}/{poi.osm_id}
                                                    </span>
                                                </td>
                                                <td>
                                                    <StatusPill status={status} />
                                                </td>
                                                <td>
                                                    <PlaceTypeSelect
                                                        poi={poi}
                                                        placeType={pick.place_type ?? null}
                                                        disabled={saving}
                                                        onChange={(placeType) =>
                                                            onSetPickPlaceType(bbox.id, placeType)
                                                        }
                                                    />
                                                </td>
                                                <td>
                                                    <a
                                                        href={editUrl}
                                                        target="_blank"
                                                        rel="noreferrer noopener"
                                                    >
                                                        Open in iD
                                                    </a>
                                                </td>
                                                <td>
                                                    {onOpenPoiFocus ? (
                                                        <button
                                                            type="button"
                                                            className="poi-list-page__focus"
                                                            onClick={() => onOpenPoiFocus(bbox.id)}
                                                        >
                                                            Focus map
                                                        </button>
                                                    ) : (
                                                        '—'
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

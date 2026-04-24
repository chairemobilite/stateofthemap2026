//! One row in the kept-bboxes list: id + status pill header above a
//! definition list of the bbox's headline numbers.

import type { KeptBbox } from '../api';

import { formatCoord, formatKeptDate, INT } from './format';
import { StatusPill } from './StatusPill';
import type { ProgressStatus } from './progress';

export interface KeptBboxRowProps {
    bbox: KeptBbox;
    status: ProgressStatus;
}

/**
 * Render a single kept-bbox card. Pure presentational — receives the
 * progress status from the parent so the row itself stays agnostic to
 * how analysis state is computed.
 *
 * @param bbox - Kept bbox payload as returned by `GET /api/bbox/kept`.
 * @param status - Analysis progress status to display in the header pill.
 */
export function KeptBboxRow({ bbox, status }: KeptBboxRowProps) {
    const [lon, lat] = bbox.center;
    return (
        <article className="kept-bbox-row" aria-label={`Bbox ${bbox.id}`}>
            <header className="kept-bbox-row__header">
                <code>{bbox.id.slice(0, 8)}</code>
                <StatusPill status={status} />
            </header>
            <dl className="kept-bbox-row__body">
                <dt>Center</dt>
                <dd>
                    {formatCoord(lat, 'lat')}, {formatCoord(lon, 'lon')}
                </dd>
                <dt>Size</dt>
                <dd>
                    {bbox.cell_size_km} × {bbox.cell_size_km} km
                </dd>
                <dt>Population</dt>
                <dd>{INT.format(bbox.population)}</dd>
                <dt>Kept</dt>
                <dd>{formatKeptDate(bbox.kept_at)}</dd>
            </dl>
        </article>
    );
}

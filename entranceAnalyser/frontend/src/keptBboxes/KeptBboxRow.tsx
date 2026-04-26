//! One row in the kept-bboxes list: id + status pill header above a
//! definition list of the bbox's headline numbers.

import type { KeptBbox } from '../api';

import { DENSITY, formatCoord, formatKeptDate, INT, PERCENT } from './format';
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
    const source = bbox.candidate_source ?? 'random';
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
                <dt>Density</dt>
                <dd>{DENSITY.format(bbox.density_per_km2)} / km²</dd>
                <dt>vs. densest cell</dt>
                <dd>{PERCENT.format(bbox.max_density_ratio)}</dd>
                <dt>Built volume</dt>
                <dd>{INT.format(bbox.built_volume)} m³</dd>
                <dt>vs. densest built cell</dt>
                <dd>{PERCENT.format(bbox.max_built_volume_ratio)}</dd>
                <dt>Kept</dt>
                <dd>{formatKeptDate(bbox.kept_at)}</dd>
                {source === 'custom_centroid' && (
                    <>
                        <dt>Cell origin</dt>
                        <dd>Custom lat/lon</dd>
                    </>
                )}
                {source === 'custom_osm' && (
                    <>
                        <dt>Cell origin</dt>
                        <dd>OSM anchor</dd>
                    </>
                )}
            </dl>
        </article>
    );
}

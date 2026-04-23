//! Sidebar panel: summary of the current candidate bbox + Keep/Reject/Skip.
//!
//! Pure presentational component driven by `useSampling`'s output so the
//! UI can be unit-tested without the API or the map.

import type { Bbox, Decision } from './api';
import type { SamplingStatus } from './useSampling';

export interface SamplingPanelProps {
    bbox: Bbox | null;
    keptCount: number;
    status: SamplingStatus;
    error: string | null;
    onDecide: (decision: Decision) => void;
    onSkip: () => void;
}

/** Format a signed degree value with N/S or E/W suffix. */
function formatCoord(value: number, axis: 'lat' | 'lon'): string {
    const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

export function SamplingPanel({
    bbox,
    keptCount,
    status,
    error,
    onDecide,
    onSkip,
}: SamplingPanelProps) {
    const busy = status === 'loading';
    return (
        <aside className="sampling-panel" aria-label="Bbox sampling">
            <h2>Candidate bbox</h2>
            {bbox ? (
                <dl>
                    <dt>Center</dt>
                    <dd>
                        {formatCoord(bbox.center[1], 'lat')}, {formatCoord(bbox.center[0], 'lon')}
                    </dd>
                    <dt>ID</dt>
                    <dd>
                        <code>{bbox.id.slice(0, 8)}</code>
                    </dd>
                </dl>
            ) : (
                <p className="sampling-panel__empty">No candidate loaded.</p>
            )}

            <div className="sampling-panel__actions">
                <button type="button" onClick={() => onDecide('keep')} disabled={!bbox || busy}>
                    Keep
                </button>
                <button type="button" onClick={() => onDecide('reject')} disabled={!bbox || busy}>
                    Reject
                </button>
                <button type="button" onClick={onSkip} disabled={busy}>
                    Skip
                </button>
            </div>

            <p className="sampling-panel__count">
                Kept so far: <strong>{keptCount}</strong>
            </p>

            {busy && <p className="sampling-panel__status">Loading…</p>}
            {error && (
                <p className="sampling-panel__error" role="alert">
                    {error}
                </p>
            )}
        </aside>
    );
}

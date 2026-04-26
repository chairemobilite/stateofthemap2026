//! Full-page tables of persisted POI-focus measurement aggregates.

import { useEffect, useState } from 'react';

import {
    fetchPoiFocusMeasurementStats,
    type MeasurementPairAggregate,
    type PoiFocusMeasurementStats,
} from './api';
import { formatMinutesSeconds } from './measurementStatsFormat';

function round1(n: number): string {
    return Number.isFinite(n) ? n.toFixed(1) : '—';
}

function StatPairTable({
    title,
    attrALabel,
    attrBLabel,
    rows,
}: {
    title: string;
    attrALabel: string;
    attrBLabel: string;
    rows: MeasurementPairAggregate[];
}) {
    if (rows.length === 0) {
        return (
            <section className="measurement-stats__section">
                <h2 className="measurement-stats__h2">{title}</h2>
                <p className="measurement-stats__empty">No measurements in this grouping.</p>
            </section>
        );
    }
    return (
        <section className="measurement-stats__section">
            <h2 className="measurement-stats__h2">{title}</h2>
            <div className="measurement-stats__scroll">
                <table className="measurement-stats__table">
                    <thead>
                        <tr>
                            <th>{attrALabel}</th>
                            <th>{attrBLabel}</th>
                            <th className="measurement-stats__num">n</th>
                            <th colSpan={4} className="measurement-stats__group">
                                Length (m)
                            </th>
                            <th colSpan={4} className="measurement-stats__group">
                                Duration (s)
                            </th>
                            <th colSpan={4} className="measurement-stats__group">
                                Duration (min:sec)
                            </th>
                        </tr>
                        <tr>
                            <th />
                            <th />
                            <th />
                            <th className="measurement-stats__num">min</th>
                            <th className="measurement-stats__num">max</th>
                            <th className="measurement-stats__num">avg</th>
                            <th className="measurement-stats__num">med</th>
                            <th className="measurement-stats__num">min</th>
                            <th className="measurement-stats__num">max</th>
                            <th className="measurement-stats__num">avg</th>
                            <th className="measurement-stats__num">med</th>
                            <th className="measurement-stats__num">min</th>
                            <th className="measurement-stats__num">max</th>
                            <th className="measurement-stats__num">avg</th>
                            <th className="measurement-stats__num">med</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={`${r.attr_a}|${r.attr_b}`}>
                                <td>
                                    <code>{r.attr_a}</code>
                                </td>
                                <td>
                                    <code>{r.attr_b}</code>
                                </td>
                                <td className="measurement-stats__num">{r.n}</td>
                                <td className="measurement-stats__num">{round1(r.length_m.min)}</td>
                                <td className="measurement-stats__num">{round1(r.length_m.max)}</td>
                                <td className="measurement-stats__num">{round1(r.length_m.avg)}</td>
                                <td className="measurement-stats__num">{round1(r.length_m.median)}</td>
                                <td className="measurement-stats__num">{round1(r.duration_s.min)}</td>
                                <td className="measurement-stats__num">{round1(r.duration_s.max)}</td>
                                <td className="measurement-stats__num">{round1(r.duration_s.avg)}</td>
                                <td className="measurement-stats__num">{round1(r.duration_s.median)}</td>
                                <td className="measurement-stats__num">
                                    {formatMinutesSeconds(r.duration_s.min)}
                                </td>
                                <td className="measurement-stats__num">
                                    {formatMinutesSeconds(r.duration_s.max)}
                                </td>
                                <td className="measurement-stats__num">
                                    {formatMinutesSeconds(r.duration_s.avg)}
                                </td>
                                <td className="measurement-stats__num">
                                    {formatMinutesSeconds(r.duration_s.median)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

/**
 * Load and display global measurement statistics from
 * `GET /api/analyses/poi_focus_measurement_stats`.
 */
export function MeasurementStatsPage() {
    const [stats, setStats] = useState<PoiFocusMeasurementStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        void (async () => {
            try {
                const s = await fetchPoiFocusMeasurementStats();
                if (!cancelled) setStats(s);
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="measurement-stats-page">
            <header className="measurement-stats-page__header">
                <h1 className="measurement-stats-page__title">Measurement statistics</h1>
                <p className="measurement-stats-page__intro">
                    Aggregates over all saved focus-map polylines. Length is geodesic path length in
                    metres; duration is <code>(length_m / 1000) / (walking_speed_kmh / 3600)</code>{' '}
                    seconds (same as the focus map walking-time estimate). Each table groups by one
                    pair of stored attributes; cells show min, max, average and median for length and
                    for duration (seconds plus a minutes:seconds reading).
                </p>
            </header>
            {loading && <p className="measurement-stats-page__status">Loading…</p>}
            {error && (
                <p className="measurement-stats-page__error" role="alert">
                    {error}
                </p>
            )}
            {!loading && !error && stats && (
                <div className="measurement-stats-page__body">
                    <StatPairTable
                        title="measurement_type × entrance_type"
                        attrALabel="measurement_type"
                        attrBLabel="entrance_type"
                        rows={stats.by_measurement_type_and_entrance_type}
                    />
                    <StatPairTable
                        title="measurement_type × start_origin"
                        attrALabel="measurement_type"
                        attrBLabel="start_origin"
                        rows={stats.by_measurement_type_and_start_origin}
                    />
                    <StatPairTable
                        title="entrance_type × start_origin"
                        attrALabel="entrance_type"
                        attrBLabel="start_origin"
                        rows={stats.by_entrance_type_and_start_origin}
                    />
                </div>
            )}
        </div>
    );
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Full-page tables of persisted POI-focus measurement aggregates and
//! per-POI destination mismatch warnings.

import { useEffect, useState } from 'react';

import {
    fetchAppConfig,
    fetchPoiFocusMeasurementDestinationWarnings,
    fetchPoiFocusMeasurementStats,
    fetchPoiPickCountryStats,
    type EndpointAgreementStat,
    type MeasurementDeltaAggregate,
    type MeasurementHistogramBin,
    type MeasurementPairAggregate,
    type PoiFocusMeasurementStats,
    type PoiPickCountryStats,
    type QuebecPlaceTypeStat,
} from './api';
import { QUEBEC_PLACE_TYPE_LABELS } from './keptBboxes/placeTypes';
import {
    DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
    aggregateDestinationWarningsByMessage,
    type DestinationWarningRow,
} from './keptBboxes/measurementDestinationWarnings';
import { formatMinutesSeconds } from './measurementStatsFormat';
import { TufteBarChart } from './TufteBarChart';
import { TufteHistogram, type TufteHistogramBin } from './TufteHistogram';

export interface MeasurementStatsPageProps {
    /** Open the focus map for one kept bbox (wired from `App`). */
    onOpenPoiFocus?: (bboxId: string) => void;
    /** Optional label for POI links in the warnings collapse (defaults to `bbox_id`). */
    poiLabelForBbox?: (bboxId: string) => string;
}

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

/** Bin width of the centroid → main entrance histogram (backend contract). */
const HISTOGRAM_BIN_M = 25;
/** Lower bound of the open-ended last bin ("250+"). */
const HISTOGRAM_OVERFLOW_M = 250;

/**
 * Fill the sparse backend histogram (empty bins omitted) into a dense,
 * contiguous 0…250+ bin list for display.
 */
function denseHistogramBins(rows: MeasurementHistogramBin[]): TufteHistogramBin[] {
    const byStart = new Map(rows.map((r) => [r.bin_start_m, r.n]));
    const bins: TufteHistogramBin[] = [];
    for (let start = 0; start < HISTOGRAM_OVERFLOW_M; start += HISTOGRAM_BIN_M) {
        bins.push({
            label: `${start}–${start + HISTOGRAM_BIN_M}`,
            count: byStart.get(start) ?? 0,
        });
    }
    bins.push({
        label: `${HISTOGRAM_OVERFLOW_M}+`,
        count: byStart.get(HISTOGRAM_OVERFLOW_M) ?? 0,
    });
    return bins;
}

function CentroidDistanceHistogramSection({
    rows,
    heading = 'Network distance from centroid to main entrance',
    chartTitle = 'Centroid → main entrance',
}: {
    /** May be missing when talking to a backend older than this field. */
    rows: MeasurementHistogramBin[] | undefined;
    /** Section heading override (e.g. the Quebec-only copy). */
    heading?: string;
    chartTitle?: string;
}) {
    const total = rows?.reduce((sum, r) => sum + r.n, 0) ?? 0;
    return (
        <section className="measurement-stats__section">
            <h2 className="measurement-stats__h2">{heading}</h2>
            <p className="measurement-stats__section-note">
                Walking distance along the network from the aggregated centroid (any
                centroid kind) to the entrance, one measurement per POI
                (<code>to_nearest_main_entrance</code> preferred over{' '}
                <code>to_nearest_entrance</code> when both exist), in{' '}
                {HISTOGRAM_BIN_M} m bins; the last bin collects everything at{' '}
                {HISTOGRAM_OVERFLOW_M} m and more.
            </p>
            {total === 0 ? (
                <p className="measurement-stats__empty">No centroid measurements yet.</p>
            ) : (
                <div className="measurement-stats__charts">
                    <TufteHistogram
                        title={chartTitle}
                        subtitle={`${total} measurement(s)`}
                        bins={denseHistogramBins(rows ?? [])}
                    />
                </div>
            )}
        </section>
    );
}

/** Destination types charted, with their display titles. The third
 *  element adds a "no <destination> / unknown" bar counting POIs with
 *  no measurement of that type — meaningful for transit stops (a POI
 *  can genuinely have none nearby), not for driving roads. */
const ENDPOINT_CHART_TYPES: ReadonlyArray<[string, string, boolean]> = [
    ['to_nearest_driving_road', 'Nearest driving road', false],
    ['to_nearest_transit_stop', 'Nearest transit stop', true],
];

function EndpointAgreementCharts({
    rows,
    matchRadiusM,
    heading = 'Do centroid walks end on the same point as main-entrance walks?',
    chartTitleSuffix = '',
}: {
    /** May be missing when talking to a backend older than this field. */
    rows: EndpointAgreementStat[] | undefined;
    matchRadiusM: number;
    /** Section heading override (e.g. the Quebec-only copy). */
    heading?: string;
    /** Appended to each chart title (e.g. " (Quebec)"). */
    chartTitleSuffix?: string;
}) {
    const charts = ENDPOINT_CHART_TYPES.map(([type, title, includeWithout]) => ({
        title: `${title}${chartTitleSuffix}`,
        includeWithout,
        stat: rows?.find((r) => r.measurement_type === type),
    }));
    return (
        <section className="measurement-stats__section">
            <h2 className="measurement-stats__h2">{heading}</h2>
            <p className="measurement-stats__section-note">
                Share of (main entrance, centroid) walk pairs of the same POI whose endpoints
                land more than <strong>{matchRadiusM} m</strong> apart (any centroid kind). For
                transit stops, POIs with no such measurement at all count in the “no stop /
                unknown” bar.
            </p>
            <div className="measurement-stats__charts">
                {charts.map(({ title, includeWithout, stat }) => {
                    // POIs with no measurement of this type widen the
                    // denominator when the chart opts in.
                    const without = includeWithout ? (stat?.n_pois_without ?? 0) : 0;
                    const total = (stat?.n_pairs ?? 0) + without;
                    return stat && total > 0 ? (
                        <TufteBarChart
                            key={title}
                            title={title}
                            subtitle={`${stat.n_pairs} pair(s)${
                                without > 0 ? `, ${without} POI(s) without` : ''
                            }`}
                            bars={[
                                {
                                    label: 'same point',
                                    value: (100 * (stat.n_pairs - stat.n_mismatch)) / total,
                                },
                                {
                                    label: 'different point',
                                    value: (100 * stat.n_mismatch) / total,
                                },
                                ...(includeWithout
                                    ? [
                                          {
                                              label: 'no stop / unknown',
                                              value: (100 * without) / total,
                                          },
                                      ]
                                    : []),
                            ]}
                        />
                    ) : (
                        <p key={title} className="measurement-stats__empty">
                            {title}: no (main, centroid) pair yet.
                        </p>
                    );
                })}
            </div>
        </section>
    );
}

/** Human labels for the Quebec place-type buckets, in display order. */
const QUEBEC_PLACE_TYPE_TABLE_ORDER = QUEBEC_PLACE_TYPE_LABELS;

function QuebecPlaceTypeTable({
    rows,
}: {
    /** May be missing when talking to a backend older than this field. */
    rows: QuebecPlaceTypeStat[] | undefined;
}) {
    const byType = new Map((rows ?? []).map((r) => [r.place_type, r]));
    const displayed = QUEBEC_PLACE_TYPE_TABLE_ORDER.filter(([type]) => byType.has(type));
    return (
        <section className="measurement-stats__section">
            <h2 className="measurement-stats__h2">Quebec POIs by place type</h2>
            <p className="measurement-stats__section-note">
                Quebec picks classified by reviewer-chosen place type or OSM tags
                (universities, parks, shopping centres, schools, transit, etc.), with
                the network walking distance from the aggregated centroid to the
                entrance, one measurement per POI (
                <code>to_nearest_main_entrance</code> preferred over{' '}
                <code>to_nearest_entrance</code> when both exist, any centroid kind).
            </p>
            {displayed.length === 0 ? (
                <p className="measurement-stats__empty">No Quebec POIs yet.</p>
            ) : (
                <div className="measurement-stats__scroll">
                    <table className="measurement-stats__table">
                        <thead>
                            <tr>
                                <th>Place type</th>
                                <th className="measurement-stats__num">POIs</th>
                                <th className="measurement-stats__num">measurements</th>
                                <th className="measurement-stats__num">min (m)</th>
                                <th className="measurement-stats__num">max (m)</th>
                                <th className="measurement-stats__num">avg (m)</th>
                                <th className="measurement-stats__num">median (m)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {displayed.map(([type, label]) => {
                                const row = byType.get(type)!;
                                return (
                                    <tr key={type}>
                                        <td>{label}</td>
                                        <td className="measurement-stats__num">{row.n_pois}</td>
                                        <td className="measurement-stats__num">
                                            {row.n_measurements}
                                        </td>
                                        <td className="measurement-stats__num">
                                            {row.length_m ? round1(row.length_m.min) : '—'}
                                        </td>
                                        <td className="measurement-stats__num">
                                            {row.length_m ? round1(row.length_m.max) : '—'}
                                        </td>
                                        <td className="measurement-stats__num">
                                            {row.length_m ? round1(row.length_m.avg) : '—'}
                                        </td>
                                        <td className="measurement-stats__num">
                                            {row.length_m ? round1(row.length_m.median) : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function CentroidDeltaTable({ rows }: { rows: MeasurementDeltaAggregate[] }) {
    const title = 'centroid vs main entrance (Δ = centroid − main)';
    if (rows.length === 0) {
        return (
            <section className="measurement-stats__section">
                <h2 className="measurement-stats__h2">{title}</h2>
                <p className="measurement-stats__empty">
                    No POI has both a main-entrance and a centroid measurement of the same type
                    yet.
                </p>
            </section>
        );
    }
    return (
        <section className="measurement-stats__section">
            <h2 className="measurement-stats__h2">{title}</h2>
            <p className="measurement-stats__section-note">
                For each POI and measurement type, every walk anchored on a centroid
                (<code>centroid_main_building</code>, <code>centroid_area</code>, …) is paired
                with the walk from the <code>main</code> entrance; positive deltas mean the
                centroid walk is longer. <code>to_nearest_entrance</code> and{' '}
                <code>to_nearest_main_entrance</code> are excluded.
            </p>
            <div className="measurement-stats__scroll">
                <table className="measurement-stats__table">
                    <thead>
                        <tr>
                            <th>measurement_type</th>
                            <th className="measurement-stats__num">n</th>
                            <th colSpan={4} className="measurement-stats__group">
                                Δ Length (m)
                            </th>
                            <th colSpan={4} className="measurement-stats__group">
                                Δ Duration (s)
                            </th>
                        </tr>
                        <tr>
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
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.measurement_type}>
                                <td>
                                    <code>{r.measurement_type}</code>
                                </td>
                                <td className="measurement-stats__num">{r.n}</td>
                                <td className="measurement-stats__num">{round1(r.delta_length_m.min)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_length_m.max)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_length_m.avg)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_length_m.median)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_duration_s.min)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_duration_s.max)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_duration_s.avg)}</td>
                                <td className="measurement-stats__num">{round1(r.delta_duration_s.median)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function PoiCountryStatsSection({ stats }: { stats: PoiPickCountryStats }) {
    return (
        <>
            <section className="measurement-stats__section">
                <h2 className="measurement-stats__h2">POIs per country</h2>
                <p className="measurement-stats__section-note">
                    {stats.total} POI(s), {stats.total_rejected} rejected —{' '}
                    {stats.total_with_rejected} total including rejected. Quebec POIs are
                    excluded here and reported in their own section below.
                </p>
                {stats.total_with_rejected === 0 ? (
                    <p className="measurement-stats__empty">No picked POIs yet.</p>
                ) : (
                    <>
                        <div className="measurement-stats__scroll">
                            <table className="measurement-stats__table">
                                <thead>
                                    <tr>
                                        <th>Country</th>
                                        <th className="measurement-stats__num">POIs</th>
                                        <th className="measurement-stats__num">rejected</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.by_country.map((row) => (
                                        <tr key={row.iso_code}>
                                            <td>
                                                {row.name} <code>{row.iso_code}</code>
                                            </td>
                                            <td className="measurement-stats__num">{row.n}</td>
                                            <td className="measurement-stats__num">
                                                {row.n_rejected}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {stats.unresolved > 0 && (
                            <p className="measurement-stats__section-note">
                                {stats.unresolved} POI(s) outside every loaded country boundary
                                (run entrance-analyser-load-boundaries).
                            </p>
                        )}
                    </>
                )}
            </section>
            <section className="measurement-stats__section">
                <h2 className="measurement-stats__h2">POIs in Quebec</h2>
                <p className="measurement-stats__section-note">
                    Analysed separately from the worldwide sample above.
                </p>
                {stats.quebec.n + stats.quebec.n_rejected === 0 ? (
                    <p className="measurement-stats__empty">No Quebec POIs yet.</p>
                ) : (
                    <p className="measurement-stats__section-note">
                        {stats.quebec.n} POI(s), {stats.quebec.n_rejected} rejected —{' '}
                        {stats.quebec.n + stats.quebec.n_rejected} total including rejected.
                    </p>
                )}
            </section>
        </>
    );
}

function DestinationWarningsSection({
    rows,
    matchRadiusM,
    onOpenPoiFocus,
    poiLabelForBbox,
}: {
    rows: DestinationWarningRow[];
    matchRadiusM: number;
    onOpenPoiFocus?: (bboxId: string) => void;
    poiLabelForBbox: (bboxId: string) => string;
}) {
    const aggregated = aggregateDestinationWarningsByMessage(rows);

    return (
        <section className="measurement-stats__section measurement-stats__section--warnings">
            <h2 className="measurement-stats__h2">Destination mismatches</h2>
            <p className="measurement-stats__section-note">
                Polylines aimed at the same destination type (transit stop, walking network, …)
                but drawn from different entrance anchors must land on the same endpoint. Endpoints
                farther than <strong>{matchRadiusM} m</strong> apart are flagged (same rule as the
                focus-map yellow banner). <code>to_nearest_entrance</code> and{' '}
                <code>to_nearest_main_entrance</code> are excluded.
            </p>
            {aggregated.length === 0 ? (
                <p className="measurement-stats__empty">No destination mismatches across kept POIs.</p>
            ) : (
                <ul className="measurement-stats__warning-list">
                    {aggregated.map((row) => (
                        <li key={row.message}>
                            <details className="measurement-stats__warning-collapse">
                                <summary className="measurement-stats__warning-summary">
                                    <span
                                        className="measurement-stats__warning-count"
                                        aria-label={`${row.bbox_ids.length} POI(s)`}
                                    >
                                        {row.bbox_ids.length}
                                    </span>
                                    <span className="measurement-stats__warning-message">
                                        {row.message}
                                    </span>
                                </summary>
                                <ul className="measurement-stats__warning-pois">
                                    {row.bbox_ids.map((bboxId) => (
                                        <li key={bboxId}>
                                            {onOpenPoiFocus ? (
                                                <button
                                                    type="button"
                                                    className="measurement-stats__poi-link"
                                                    onClick={() => onOpenPoiFocus(bboxId)}
                                                >
                                                    {poiLabelForBbox(bboxId)}
                                                </button>
                                            ) : (
                                                <code className="measurement-stats__bbox-id">
                                                    {poiLabelForBbox(bboxId)}
                                                </code>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/**
 * Load and display global measurement statistics from
 * `GET /api/analyses/poi_focus_measurement_stats` and destination
 * mismatch warnings from
 * `GET /api/analyses/poi_focus_measurement_destination_warnings`.
 */
export function MeasurementStatsPage({
    onOpenPoiFocus,
    poiLabelForBbox = (bboxId) => bboxId,
}: MeasurementStatsPageProps = {}) {
    const [stats, setStats] = useState<PoiFocusMeasurementStats | null>(null);
    const [countryStats, setCountryStats] = useState<PoiPickCountryStats | null>(null);
    const [destinationWarnings, setDestinationWarnings] = useState<DestinationWarningRow[] | null>(
        null,
    );
    const [matchRadiusM, setMatchRadiusM] = useState(DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        void (async () => {
            try {
                const [s, countries, warningsBody, config] = await Promise.all([
                    fetchPoiFocusMeasurementStats(),
                    fetchPoiPickCountryStats(),
                    fetchPoiFocusMeasurementDestinationWarnings(),
                    fetchAppConfig(),
                ]);
                if (cancelled) return;
                setStats(s);
                setCountryStats(countries);
                setDestinationWarnings(warningsBody.warnings);
                setMatchRadiusM(
                    config.measurement_destination_match_radius_m ??
                        DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
                );
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
                    for duration (seconds plus a minutes:seconds reading). Quebec POIs are analysed
                    separately: every chart and table excludes them unless marked “(Quebec)”.
                </p>
            </header>
            {loading && <p className="measurement-stats-page__status">Loading…</p>}
            {error && (
                <p className="measurement-stats-page__error" role="alert">
                    {error}
                </p>
            )}
            {!loading && !error && stats && destinationWarnings !== null && (
                <div className="measurement-stats-page__body">
                    {countryStats && <PoiCountryStatsSection stats={countryStats} />}
                    <DestinationWarningsSection
                        rows={destinationWarnings}
                        matchRadiusM={matchRadiusM}
                        onOpenPoiFocus={onOpenPoiFocus}
                        poiLabelForBbox={poiLabelForBbox}
                    />
                    <EndpointAgreementCharts
                        rows={stats.main_entrance_vs_centroid_endpoints}
                        matchRadiusM={matchRadiusM}
                    />
                    <EndpointAgreementCharts
                        rows={stats.main_entrance_vs_centroid_endpoints_quebec}
                        matchRadiusM={matchRadiusM}
                        heading="Do centroid walks end on the same point as main-entrance walks? (Quebec)"
                        chartTitleSuffix=" (Quebec)"
                    />
                    <CentroidDistanceHistogramSection
                        rows={stats.centroid_to_main_entrance_histogram}
                    />
                    <CentroidDistanceHistogramSection
                        rows={stats.centroid_to_main_entrance_histogram_quebec}
                        heading="Network distance from centroid to main entrance (Quebec)"
                        chartTitle="Centroid → main entrance (Quebec)"
                    />
                    <QuebecPlaceTypeTable rows={stats.quebec_by_place_type} />
                    <CentroidDeltaTable rows={stats.main_entrance_vs_centroid} />
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

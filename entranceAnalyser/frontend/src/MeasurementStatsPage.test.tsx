/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MeasurementStatsPage } from './MeasurementStatsPage';

vi.mock('./api', () => ({
    fetchPoiFocusMeasurementStats: vi.fn(),
    fetchPoiFocusMeasurementDestinationWarnings: vi.fn(),
    fetchPoiPickCountryStats: vi.fn(),
    fetchAppConfig: vi.fn(),
}));

import {
    fetchAppConfig,
    fetchPoiFocusMeasurementDestinationWarnings,
    fetchPoiFocusMeasurementStats,
    fetchPoiPickCountryStats,
} from './api';

const EMPTY_STATS = {
    by_measurement_type_and_entrance_type: [],
    by_measurement_type_and_start_origin: [],
    by_entrance_type_and_start_origin: [],
    main_entrance_vs_centroid: [],
    main_entrance_vs_centroid_endpoints: [],
};

const EMPTY_COUNTRY_STATS = {
    by_country: [],
    total: 0,
    total_rejected: 0,
    total_with_rejected: 0,
    quebec: { n: 0, n_rejected: 0 },
    unresolved: 0,
};

const TRANSIT_MSG =
    'The nearest transit stop is not the same for main building centroid and main entrance';

describe('<MeasurementStatsPage />', () => {
    it('aggregates warnings by message with a POI count', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({
            warnings: [
                { bbox_id: '00000000-0000-4000-8000-000000000099', warnings: [TRANSIT_MSG] },
                { bbox_id: '00000000-0000-4000-8000-000000000188', warnings: [TRANSIT_MSG] },
            ],
        });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(screen.getByText('Destination mismatches')).toBeInTheDocument();
        });

        expect(screen.getByText('2', { selector: '.measurement-stats__warning-count' })).toBeInTheDocument();
        expect(screen.getByText(TRANSIT_MSG)).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('opens POI focus when a collapsed POI link is clicked', async () => {
        const onOpenPoiFocus = vi.fn();
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({
            warnings: [
                { bbox_id: '00000000-0000-4000-8000-000000000099', warnings: [TRANSIT_MSG] },
            ],
        });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(
            <MeasurementStatsPage
                onOpenPoiFocus={onOpenPoiFocus}
                poiLabelForBbox={() => 'Test POI'}
            />,
        );

        await waitFor(() => {
            expect(screen.getByText('Test POI')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: 'Test POI' }));
        expect(onOpenPoiFocus).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000099');
    });

    it.each([
        ['CA row', 'Canada', '3', '1'],
        ['FR row', 'France', '1', '0'],
    ])('POIs per country table: %s', async (_label, countryName, nCell, rejectedCell) => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue({
            by_country: [
                { iso_code: 'CA', name: 'Canada', n: 3, n_rejected: 1 },
                { iso_code: 'FR', name: 'France', n: 1, n_rejected: 0 },
            ],
            total: 5,
            total_rejected: 1,
            total_with_rejected: 6,
            quebec: { n: 2, n_rejected: 1 },
            unresolved: 1,
        });
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(screen.getByText('POIs per country')).toBeInTheDocument();
        });

        const row = screen.getByText(countryName).closest('tr');
        expect(row).not.toBeNull();
        // Cells: country | POIs | rejected.
        expect(row!.children[1]).toHaveTextContent(nCell);
        expect(row!.children[2]).toHaveTextContent(rejectedCell);
        // Totals under the title, then the dedicated Quebec section.
        expect(
            screen.getByText(/5 POI\(s\), 1 rejected — 6 total including rejected/),
        ).toBeInTheDocument();
        expect(screen.getByText(/1 POI\(s\) outside every loaded country boundary/)).toBeInTheDocument();
        expect(screen.getByText('POIs in Quebec')).toBeInTheDocument();
        expect(
            screen.getByText(/2 POI\(s\), 1 rejected — 3 total including rejected/),
        ).toBeInTheDocument();
    });

    it.each([
        ['driving road: 1 of 4 pairs mismatch', 'to_nearest_driving_road', 'Nearest driving road', 4, 1, '75%', '25%'],
        ['transit stop: all 2 pairs mismatch', 'to_nearest_transit_stop', 'Nearest transit stop', 2, 2, '0%', '100%'],
    ])(
        'endpoint agreement chart — %s',
        async (_label, type, title, nPairs, nMismatch, samePct, diffPct) => {
            vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue({
                ...EMPTY_STATS,
                main_entrance_vs_centroid_endpoints: [
                    { measurement_type: type, n_pairs: nPairs, n_mismatch: nMismatch },
                ],
            });
            vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
            vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({
                warnings: [],
            });
            vi.mocked(fetchAppConfig).mockResolvedValue({
                osm_editor_url: 'https://example.org/edit',
                poi_focus_radius_m: 150,
                measurement_destination_match_radius_m: 10,
            });

            render(<MeasurementStatsPage />);

            await waitFor(() => {
                expect(screen.getByRole('img', { name: title })).toBeInTheDocument();
            });

            const chart = screen.getByRole('img', { name: title });
            expect(chart).toHaveTextContent(samePct);
            expect(chart).toHaveTextContent(diffPct);
            expect(screen.getByText(`${nPairs} pair(s)`)).toBeInTheDocument();
        },
    );

    it('adds a "no stop / unknown" bar to the transit chart for POIs without a measurement', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue({
            ...EMPTY_STATS,
            main_entrance_vs_centroid_endpoints: [
                // 1 pair (matching) + 3 POIs without any transit
                // measurement → 25% / 0% / 75% of 4 POIs.
                {
                    measurement_type: 'to_nearest_transit_stop',
                    n_pairs: 1,
                    n_mismatch: 0,
                    n_pois_without: 3,
                },
            ],
        });
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(screen.getByRole('img', { name: 'Nearest transit stop' })).toBeInTheDocument();
        });

        const chart = screen.getByRole('img', { name: 'Nearest transit stop' });
        expect(chart).toHaveTextContent('no stop / unknown');
        expect(chart).toHaveTextContent('25%');
        expect(chart).toHaveTextContent('75%');
        expect(screen.getByText('1 pair(s), 3 POI(s) without')).toBeInTheDocument();
    });

    it('renders centroid-vs-main deltas per measurement type', async () => {
        const four = (v: number) => ({ min: v, max: v, avg: v, median: v });
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue({
            ...EMPTY_STATS,
            main_entrance_vs_centroid: [
                {
                    measurement_type: 'to_nearest_transit_stop',
                    n: 4,
                    delta_length_m: four(12.5),
                    delta_duration_s: four(9),
                },
            ],
        });
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(
                screen.getByText('centroid vs main entrance (Δ = centroid − main)'),
            ).toBeInTheDocument();
        });

        const row = screen.getByText('to_nearest_transit_stop').closest('tr');
        expect(row).not.toBeNull();
        expect(row!).toHaveTextContent('4');
        expect(row!).toHaveTextContent('12.5');
        expect(row!).toHaveTextContent('9.0');
    });

    it('renders the centroid → main entrance distance histogram with dense bins', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue({
            ...EMPTY_STATS,
            // Sparse backend bins: 0–25 (70), 100–125 (8), 250+ (3).
            centroid_to_main_entrance_histogram: [
                { bin_start_m: 0, n: 70 },
                { bin_start_m: 100, n: 8 },
                { bin_start_m: 250, n: 3 },
            ],
        });
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(
                screen.getByRole('img', { name: 'Centroid → main entrance' }),
            ).toBeInTheDocument();
        });

        const chart = screen.getByRole('img', { name: 'Centroid → main entrance' });
        // All 11 bin labels present, including zero-count in-between bins.
        for (const label of ['0–25', '25–50', '100–125', '225–250', '250+']) {
            expect(chart).toHaveTextContent(label);
        }
        expect(chart).toHaveTextContent('70');
        expect(chart).toHaveTextContent('8');
        expect(chart).toHaveTextContent('3');
        expect(screen.getByText('81 measurement(s)')).toBeInTheDocument();
    });

    it('shows the histogram empty state when there are no centroid measurements', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            // Two empty histogram sections: worldwide and Quebec-only.
            expect(screen.getAllByText('No centroid measurements yet.')).toHaveLength(2);
        });
    });

    it('renders the Quebec-only copies of the endpoint charts and histogram', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue({
            ...EMPTY_STATS,
            main_entrance_vs_centroid_endpoints_quebec: [
                { measurement_type: 'to_nearest_transit_stop', n_pairs: 2, n_mismatch: 1 },
            ],
            centroid_to_main_entrance_histogram_quebec: [{ bin_start_m: 25, n: 2 }],
        });
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(
                screen.getByRole('img', { name: 'Nearest transit stop (Quebec)' }),
            ).toBeInTheDocument();
        });

        const chart = screen.getByRole('img', { name: 'Nearest transit stop (Quebec)' });
        expect(chart).toHaveTextContent('50%');
        const histogram = screen.getByRole('img', { name: 'Centroid → main entrance (Quebec)' });
        expect(histogram).toHaveTextContent('25–50');
        expect(screen.getByText('2 measurement(s)')).toBeInTheDocument();
    });

    it('renders the Quebec place-type table with distance aggregates', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue({
            ...EMPTY_STATS,
            quebec_by_place_type: [
                {
                    place_type: 'university',
                    n_pois: 2,
                    n_measurements: 3,
                    length_m: { min: 10, max: 80, avg: 40, median: 30 },
                },
                { place_type: 'hospital', n_pois: 1, n_measurements: 0, length_m: null },
            ],
        });
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(screen.getByText('Quebec POIs by place type')).toBeInTheDocument();
        });

        const uniRow = screen.getByText('Universities').closest('tr')!;
        // Cells: label | POIs | measurements | min | max | avg | median.
        expect(uniRow.children[1]).toHaveTextContent('2');
        expect(uniRow.children[2]).toHaveTextContent('3');
        expect(uniRow.children[3]).toHaveTextContent('10.0');
        expect(uniRow.children[6]).toHaveTextContent('30.0');
        // No measurement yet: dashes instead of numbers.
        const hospitalRow = screen.getByText('Hospitals').closest('tr')!;
        expect(hospitalRow.children[1]).toHaveTextContent('1');
        expect(hospitalRow.children[3]).toHaveTextContent('—');
        // Buckets absent from the payload are not rendered.
        expect(screen.queryByText('Industrial')).not.toBeInTheDocument();
    });

    it('shows empty state when there are no destination mismatches', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue(EMPTY_COUNTRY_STATS);
        vi.mocked(fetchPoiFocusMeasurementDestinationWarnings).mockResolvedValue({ warnings: [] });
        vi.mocked(fetchAppConfig).mockResolvedValue({
            osm_editor_url: 'https://example.org/edit',
            poi_focus_radius_m: 150,
            measurement_destination_match_radius_m: 10,
        });

        render(<MeasurementStatsPage />);

        await waitFor(() => {
            expect(
                screen.getByText('No destination mismatches across kept POIs.'),
            ).toBeInTheDocument();
        });
    });
});

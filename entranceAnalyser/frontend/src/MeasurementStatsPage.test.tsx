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
};

const EMPTY_COUNTRY_STATS = { by_country: [], total: 0, unresolved: 0 };

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
        ['CA row shows the Quebec subset', 'Canada', '2'],
        ['non-CA row shows a dash instead of a Quebec count', 'France', '—'],
    ])('POIs per country table: %s', async (_label, countryName, quebecCell) => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
        vi.mocked(fetchPoiPickCountryStats).mockResolvedValue({
            by_country: [
                { iso_code: 'CA', name: 'Canada', n: 3, n_in_quebec: 2 },
                { iso_code: 'FR', name: 'France', n: 1, n_in_quebec: 0 },
            ],
            total: 5,
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
        expect(row!.lastElementChild).toHaveTextContent(quebecCell);
        expect(screen.getByText(/5 POI\(s\) total/)).toBeInTheDocument();
        expect(screen.getByText(/1 outside every loaded country boundary/)).toBeInTheDocument();
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

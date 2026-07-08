import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MeasurementStatsPage } from './MeasurementStatsPage';

vi.mock('./api', () => ({
    fetchPoiFocusMeasurementStats: vi.fn(),
    fetchPoiFocusMeasurementDestinationWarnings: vi.fn(),
    fetchAppConfig: vi.fn(),
}));

import {
    fetchAppConfig,
    fetchPoiFocusMeasurementDestinationWarnings,
    fetchPoiFocusMeasurementStats,
} from './api';

const EMPTY_STATS = {
    by_measurement_type_and_entrance_type: [],
    by_measurement_type_and_start_origin: [],
    by_entrance_type_and_start_origin: [],
};

const TRANSIT_MSG =
    'The nearest transit stop is not the same for main building centroid and main entrance';

describe('<MeasurementStatsPage />', () => {
    it('aggregates warnings by message with a POI count', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
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

    it('shows empty state when there are no destination mismatches', async () => {
        vi.mocked(fetchPoiFocusMeasurementStats).mockResolvedValue(EMPTY_STATS);
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

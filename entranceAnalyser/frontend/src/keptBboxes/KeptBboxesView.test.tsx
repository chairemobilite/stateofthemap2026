import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { makeKeptBbox } from '../test/fixtures';
import { KeptBboxesView, type KeptBboxesViewProps } from './KeptBboxesView';

function renderView(overrides: Partial<KeptBboxesViewProps> = {}) {
    const props: KeptBboxesViewProps = {
        keptBboxes: [],
        status: 'idle',
        error: null,
        ...overrides,
    };
    return render(<KeptBboxesView {...props} />);
}

describe('<KeptBboxesView />', () => {
    it('shows an empty state when no bboxes are kept yet', () => {
        renderView();
        expect(screen.getByRole('heading', { name: /Kept bboxes \(0\)/ })).toBeInTheDocument();
        expect(screen.getByText(/No bboxes have been kept yet/)).toBeInTheDocument();
        expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('renders one row per kept bbox with id prefix, center, size and population', () => {
        const bboxes = [
            makeKeptBbox({ id: 'aaaaaaaa-0000-0000-0000-000000000001' }),
            makeKeptBbox({
                id: 'bbbbbbbb-0000-0000-0000-000000000002',
                center: [2.35, 48.85],
                cell_size_km: 25,
                population: 500_000,
            }),
        ];
        renderView({ keptBboxes: bboxes });

        expect(screen.getByRole('heading', { name: /Kept bboxes \(2\)/ })).toBeInTheDocument();

        const items = screen.getAllByRole('listitem');
        expect(items).toHaveLength(2);

        const first = within(items[0]);
        expect(first.getByText('aaaaaaaa')).toBeInTheDocument();
        expect(first.getByText(/45\.5500° N/)).toBeInTheDocument();
        expect(first.getByText(/73\.5500° W/)).toBeInTheDocument();
        expect(first.getByText('10 × 10 km')).toBeInTheDocument();
        expect(first.getByText('12,500')).toBeInTheDocument();

        const second = within(items[1]);
        expect(second.getByText('bbbbbbbb')).toBeInTheDocument();
        expect(second.getByText(/48\.8500° N/)).toBeInTheDocument();
        expect(second.getByText(/2\.3500° E/)).toBeInTheDocument();
        expect(second.getByText('25 × 25 km')).toBeInTheDocument();
        expect(second.getByText('500,000')).toBeInTheDocument();
    });

    it('paints every row with the Not started progress pill in this PR', () => {
        renderView({
            keptBboxes: [makeKeptBbox({ id: 'a' }), makeKeptBbox({ id: 'b' })],
        });
        const pills = screen.getAllByText('Not started');
        expect(pills).toHaveLength(2);
        pills.forEach((pill) => expect(pill).toHaveAttribute('data-status', 'not_started'));
    });

    it('shows the loading indicator while status is loading', () => {
        renderView({ status: 'loading' });
        expect(screen.getByText('Loading…')).toBeInTheDocument();
    });

    it('surfaces fetch errors via role="alert"', () => {
        renderView({ status: 'error', error: 'backend unreachable' });
        expect(screen.getByRole('alert')).toHaveTextContent('backend unreachable');
    });
});

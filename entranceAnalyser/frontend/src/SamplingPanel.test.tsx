import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DEFAULT_STRATEGY, type Bbox, type Strategy } from './api';
import { SamplingPanel, type SamplingPanelProps } from './SamplingPanel';
import type { SamplingStatus } from './useSampling';
import { makeBbox } from './test/fixtures';

const BBOX = makeBbox();
const noop = () => {};

/** Renders the panel with sensible defaults; tests only override what they care about. */
function renderPanel(overrides: Partial<SamplingPanelProps> = {}) {
    const props: SamplingPanelProps = {
        bbox: BBOX,
        keptCount: 0,
        status: 'idle' as SamplingStatus,
        error: null,
        strategy: DEFAULT_STRATEGY,
        onStrategyChange: noop,
        onDecide: noop,
        onSkip: noop,
        ...overrides,
    };
    return render(<SamplingPanel {...props} />);
}

describe('<SamplingPanel />', () => {
    it('renders the bbox center with N/W hemisphere suffixes and shortens the id', () => {
        renderPanel({ keptCount: 3 });
        expect(screen.getByText(/45\.5500° N/)).toBeInTheDocument();
        expect(screen.getByText(/73\.5500° W/)).toBeInTheDocument();
        expect(screen.getByText('abcd1234')).toBeInTheDocument();
        expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('renders population, density, built-volume and both ratios', () => {
        renderPanel({
            bbox: makeBbox({
                cell_size_km: 10,
                population: 12_500,
                density_per_km2: 125,
                max_density_ratio: 0.05,
                built_volume: 750_000,
                max_built_volume_ratio: 0.3,
            }),
        });
        expect(screen.getByText('10 × 10 km')).toBeInTheDocument();
        expect(screen.getByText('12,500')).toBeInTheDocument();
        expect(screen.getByText('125 / km²')).toBeInTheDocument();
        expect(screen.getByText('5.0%')).toBeInTheDocument();
        expect(screen.getByText('750,000 m³')).toBeInTheDocument();
        expect(screen.getByText('30.0%')).toBeInTheDocument();
    });

    it.each(['keep', 'reject'] as const)(
        'fires onDecide(%s) when the matching button is clicked',
        (decision) => {
            const onDecide = vi.fn();
            renderPanel({ onDecide });
            const label = decision === 'keep' ? 'Keep' : 'Reject';
            fireEvent.click(screen.getByRole('button', { name: label }));
            expect(onDecide).toHaveBeenCalledExactlyOnceWith(decision);
        },
    );

    it('fires onSkip when the Skip button is clicked', () => {
        const onSkip = vi.fn();
        renderPanel({ onSkip });
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        expect(onSkip).toHaveBeenCalledOnce();
    });

    it('fires onStrategyChange when a new strategy is picked', () => {
        const onStrategyChange = vi.fn<(next: Strategy) => void>();
        renderPanel({ onStrategyChange });
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'uniform' } });
        expect(onStrategyChange).toHaveBeenCalledExactlyOnceWith({
            name: 'uniform',
            alpha: DEFAULT_STRATEGY.alpha,
        });
    });

    it('surfaces errors via role="alert"', () => {
        renderPanel({ status: 'error', error: 'backend exploded' });
        expect(screen.getByRole('alert')).toHaveTextContent('backend exploded');
    });

    it.each(['Keep', 'Reject', 'Skip'])(
        'disables the %s button while status is loading',
        (label) => {
            renderPanel({ status: 'loading' });
            expect(screen.getByRole('button', { name: label })).toBeDisabled();
        },
    );

    it('shows an empty-state message and disables Keep/Reject when no bbox is loaded', () => {
        renderPanel({ bbox: null as Bbox | null, status: 'loading' });
        expect(screen.getByText('No candidate loaded.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    });
});

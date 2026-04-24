import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SamplingPanel } from './SamplingPanel';
import { makeBbox } from './test/fixtures';

const BBOX = makeBbox();

const noop = () => {};

describe('<SamplingPanel />', () => {
    it('renders the bbox center with N/W hemisphere suffixes and shortens the id', () => {
        render(
            <SamplingPanel
                bbox={BBOX}
                keptCount={3}
                status="idle"
                error={null}
                onDecide={noop}
                onSkip={noop}
            />,
        );
        expect(screen.getByText(/45\.5500° N/)).toBeInTheDocument();
        expect(screen.getByText(/73\.5500° W/)).toBeInTheDocument();
        expect(screen.getByText('abcd1234')).toBeInTheDocument();
        expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('renders the population, density and ratio against the densest cell', () => {
        render(
            <SamplingPanel
                bbox={makeBbox({
                    cell_size_km: 10,
                    population: 12_500,
                    density_per_km2: 125,
                    max_density_ratio: 0.05,
                })}
                keptCount={0}
                status="idle"
                error={null}
                onDecide={noop}
                onSkip={noop}
            />,
        );
        expect(screen.getByText('10 × 10 km')).toBeInTheDocument();
        expect(screen.getByText('12,500')).toBeInTheDocument();
        expect(screen.getByText('125 / km²')).toBeInTheDocument();
        expect(screen.getByText('5.0%')).toBeInTheDocument();
    });

    it.each(['keep', 'reject'] as const)('fires onDecide(%s) when the matching button is clicked', (decision) => {
        const onDecide = vi.fn();
        render(
            <SamplingPanel
                bbox={BBOX}
                keptCount={0}
                status="idle"
                error={null}
                onDecide={onDecide}
                onSkip={noop}
            />,
        );
        const label = decision === 'keep' ? 'Keep' : 'Reject';
        fireEvent.click(screen.getByRole('button', { name: label }));
        expect(onDecide).toHaveBeenCalledExactlyOnceWith(decision);
    });

    it('fires onSkip when the Skip button is clicked', () => {
        const onSkip = vi.fn();
        render(
            <SamplingPanel
                bbox={BBOX}
                keptCount={0}
                status="idle"
                error={null}
                onDecide={noop}
                onSkip={onSkip}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        expect(onSkip).toHaveBeenCalledOnce();
    });

    it('surfaces errors via role="alert"', () => {
        render(
            <SamplingPanel
                bbox={BBOX}
                keptCount={0}
                status="error"
                error="backend exploded"
                onDecide={noop}
                onSkip={noop}
            />,
        );
        expect(screen.getByRole('alert')).toHaveTextContent('backend exploded');
    });

    it.each(['Keep', 'Reject', 'Skip'])('disables the %s button while status is loading', (label) => {
        render(
            <SamplingPanel
                bbox={BBOX}
                keptCount={0}
                status="loading"
                error={null}
                onDecide={noop}
                onSkip={noop}
            />,
        );
        expect(screen.getByRole('button', { name: label })).toBeDisabled();
    });

    it('shows an empty-state message and disables Keep/Reject when no bbox is loaded', () => {
        render(
            <SamplingPanel
                bbox={null}
                keptCount={0}
                status="loading"
                error={null}
                onDecide={noop}
                onSkip={noop}
            />,
        );
        expect(screen.getByText('No candidate loaded.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    });
});

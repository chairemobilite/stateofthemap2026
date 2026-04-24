import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Bbox } from './api';
import { SamplingPanel } from './SamplingPanel';

const BBOX: Bbox = {
    id: 'abcd1234-0000-0000-0000-000000000001',
    west: -73.6,
    south: 45.5,
    east: -73.5,
    north: 45.6,
    center: [-73.55, 45.55],
    population: null,
    filtered: false,
};

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

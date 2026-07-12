/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { makePoi } from '../test/fixtures';
import { PoiPickPanel, type PoiPickPanelProps } from './PoiPickPanel';

const noop = () => {};

function renderPanel(overrides: Partial<PoiPickPanelProps> = {}) {
    const props: PoiPickPanelProps = {
        bboxId: 'bbox-1',
        pickedPoi: undefined,
        pickCompleted: false,
        isPicking: false,
        onPick: noop,
        ...overrides,
    };
    return render(<PoiPickPanel {...props} />);
}

describe('<PoiPickPanel />', () => {
    it.each([
        { isPicking: false, expectedLabel: 'Pick POI', expectedDisabled: false },
        { isPicking: true, expectedLabel: 'Picking…', expectedDisabled: true },
    ])(
        'renders the pick button label/disabled state from isPicking ($isPicking)',
        ({ isPicking, expectedLabel, expectedDisabled }) => {
            renderPanel({ isPicking });
            const button = screen.getByRole('button', { name: expectedLabel });
            expect(button).toBeInTheDocument();
            expect((button as HTMLButtonElement).disabled).toBe(expectedDisabled);
        },
    );

    it('fires onPick(bboxId) when the button is clicked', () => {
        const onPick = vi.fn();
        renderPanel({ bboxId: 'abc-123', onPick });
        fireEvent.click(screen.getByRole('button', { name: 'Pick POI' }));
        expect(onPick).toHaveBeenCalledExactlyOnceWith('abc-123');
    });

    it('renders the empty-state message when picked but Overpass returned nothing', () => {
        renderPanel({ pickedPoi: null, pickCompleted: false });
        expect(screen.getByText('No POI in this cell.')).toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('renders the picked POI details with an OSM permalink', () => {
        renderPanel({
            pickedPoi: makePoi({
                osm_type: 'way',
                osm_id: 4242,
                tags: { shop: 'bakery', name: 'Pain Doré' },
                group: 'shops',
            }),
            pickCompleted: false,
        });
        expect(screen.getByText('Pain Doré')).toBeInTheDocument();
        expect(screen.getByText('shops')).toBeInTheDocument();
        expect(screen.getByText('shop=bakery')).toBeInTheDocument();
        const link = screen.getByRole('link', { name: 'way/4242' });
        expect(link).toHaveAttribute('href', 'https://www.openstreetmap.org/way/4242');
    });

    it('falls back to "{type} {id}" when the picked POI has no name', () => {
        renderPanel({
            pickedPoi: makePoi({
                osm_type: 'node',
                osm_id: 99,
                tags: { amenity: 'bench' },
            }),
            pickCompleted: false,
        });
        expect(screen.getByText('node 99')).toBeInTheDocument();
        expect(screen.getByText('amenity=bench')).toBeInTheDocument();
    });

    it.each([
        { name: 'no pick yet', pickedPoi: undefined },
        { name: 'picked-empty', pickedPoi: null },
    ])(
        'omits the "Open focus map" button when there is no real POI ($name)',
        ({ pickedPoi }) => {
            renderPanel({ pickedPoi, pickCompleted: false, onOpenFocus: vi.fn() });
            expect(screen.queryByRole('button', { name: /open focus map/i })).not.toBeInTheDocument();
        },
    );

    it('omits the "Open focus map" button when no onOpenFocus handler is provided', () => {
        renderPanel({ pickedPoi: makePoi(), pickCompleted: false });
        expect(screen.queryByRole('button', { name: /open focus map/i })).not.toBeInTheDocument();
    });

    it('shows an enabled "Open focus map" button when a POI is picked', () => {
        const onOpenFocus = vi.fn();
        renderPanel({ bboxId: 'bbox-7', pickedPoi: makePoi(), pickCompleted: false, onOpenFocus });
        const button = screen.getByRole('button', { name: 'Open focus map' });
        expect((button as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(button);
        expect(onOpenFocus).toHaveBeenCalledExactlyOnceWith('bbox-7');
    });

    it('flips the "Open focus map" button to a disabled "Loading…" while the focus load is in flight', () => {
        renderPanel({
            pickedPoi: makePoi(),
            pickCompleted: false,
            onOpenFocus: vi.fn(),
            isOpeningFocus: true,
        });
        const button = screen.getByRole('button', { name: 'Loading…' });
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('fires onSetPickCompleted when the completed checkbox is toggled', () => {
        const onSetPickCompleted = vi.fn();
        renderPanel({
            pickedPoi: makePoi(),
            pickCompleted: false,
            onSetPickCompleted,
        });
        const box = screen.getByRole('checkbox', { name: /mark poi completed/i });
        fireEvent.click(box);
        expect(onSetPickCompleted).toHaveBeenCalledExactlyOnceWith('bbox-1', true);
    });

    it('disables the completed checkbox while a pick decision is in flight', () => {
        renderPanel({
            pickedPoi: makePoi(),
            pickCompleted: false,
            isSavingPickDecision: true,
            onSetPickCompleted: vi.fn(),
        });
        const box = screen.getByRole('checkbox', { name: /mark poi completed/i });
        expect((box as HTMLInputElement).disabled).toBe(true);
    });

    it('does not surface any Reject affordance (reject lives only on the focus map)', () => {
        renderPanel({
            pickedPoi: makePoi(),
            onSetPickCompleted: vi.fn(),
        });
        expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });
});

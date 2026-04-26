import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { makeKeptBbox, makePoi } from '../test/fixtures';
import { KeptBboxPopup } from './KeptBboxPopup';

const noop = () => {};

describe('<KeptBboxPopup />', () => {
    it.each([
        {
            name: 'no pick yet',
            pickedPoi: undefined,
            pickCompleted: false,
            isPicking: false,
            expected: 'Not started',
        },
        {
            name: 'pick in flight',
            pickedPoi: undefined,
            pickCompleted: false,
            isPicking: true,
            expected: 'Running',
        },
        {
            name: 'picked-empty',
            pickedPoi: null,
            pickCompleted: false,
            isPicking: false,
            expected: 'Done',
        },
    ])(
        'maps ($name) to the "$expected" status pill',
        ({ pickedPoi, pickCompleted, isPicking, expected }) => {
            render(
                <KeptBboxPopup
                    bbox={makeKeptBbox()}
                    pickedPoi={pickedPoi}
                    pickCompleted={pickCompleted}
                    isPicking={isPicking}
                    onPick={noop}
                />,
            );
            expect(screen.getByText(expected)).toBeInTheDocument();
        },
    );

    it('marks a real picked POI as Started when not completed', () => {
        render(
            <KeptBboxPopup
                bbox={makeKeptBbox()}
                pickedPoi={makePoi({ tags: { shop: 'bakery', name: 'Pain' }, group: 'shops' })}
                pickCompleted={false}
                isPicking={false}
                onPick={noop}
            />,
        );
        expect(screen.getByText('Started')).toBeInTheDocument();
        expect(screen.getByText('Pain')).toBeInTheDocument();
        expect(screen.getByText('shops')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /pick poi/i })).not.toBeInTheDocument();
    });

    it('shows Completed pill when pickCompleted is true', () => {
        render(
            <KeptBboxPopup
                bbox={makeKeptBbox()}
                pickedPoi={makePoi()}
                pickCompleted
                isPicking={false}
                onPick={noop}
            />,
        );
        expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('forwards onOpenFocus(bboxId) from the picked-state focus button', () => {
        const onOpenFocus = vi.fn();
        const bbox = makeKeptBbox({ id: 'bbox-42' });
        render(
            <KeptBboxPopup
                bbox={bbox}
                pickedPoi={makePoi()}
                pickCompleted={false}
                isPicking={false}
                onPick={noop}
                onOpenFocus={onOpenFocus}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Open focus map' }));
        expect(onOpenFocus).toHaveBeenCalledExactlyOnceWith('bbox-42');
    });

    it('calls onRemoveFromKept with the bbox id', () => {
        const onRemoveFromKept = vi.fn();
        const bbox = makeKeptBbox({ id: 'drop-me' });
        render(
            <KeptBboxPopup
                bbox={bbox}
                pickedPoi={makePoi()}
                pickCompleted={false}
                isPicking={false}
                onPick={noop}
                onRemoveFromKept={onRemoveFromKept}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /remove from kept/i }));
        expect(onRemoveFromKept).toHaveBeenCalledExactlyOnceWith('drop-me');
    });
});

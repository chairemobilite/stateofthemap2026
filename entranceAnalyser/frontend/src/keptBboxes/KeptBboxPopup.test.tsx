import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { makeKeptBbox, makePoi } from '../test/fixtures';
import { KeptBboxPopup } from './KeptBboxPopup';

const noop = () => {};

describe('<KeptBboxPopup />', () => {
    it.each([
        { name: 'no pick yet', pickedPoi: undefined, isPicking: false, expected: 'Not started' },
        { name: 'pick in flight', pickedPoi: undefined, isPicking: true, expected: 'Running' },
        { name: 'picked-empty', pickedPoi: null, isPicking: false, expected: 'Done' },
    ])(
        'maps ($name) to the "$expected" status pill',
        ({ pickedPoi, isPicking, expected }) => {
            render(
                <KeptBboxPopup
                    bbox={makeKeptBbox()}
                    pickedPoi={pickedPoi}
                    isPicking={isPicking}
                    onPick={noop}
                />,
            );
            expect(screen.getByText(expected)).toBeInTheDocument();
        },
    );

    it('marks a real picked POI as Done and shows its details', () => {
        render(
            <KeptBboxPopup
                bbox={makeKeptBbox()}
                pickedPoi={makePoi({ tags: { shop: 'bakery', name: 'Pain' }, group: 'shops' })}
                isPicking={false}
                onPick={noop}
            />,
        );
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.getByText('Pain')).toBeInTheDocument();
        expect(screen.getByText('shops')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /pick poi/i })).not.toBeInTheDocument();
    });

    it('forwards onOpenFocus(bboxId) from the picked-state focus button', () => {
        const onOpenFocus = vi.fn();
        const bbox = makeKeptBbox({ id: 'bbox-42' });
        render(
            <KeptBboxPopup
                bbox={bbox}
                pickedPoi={makePoi()}
                isPicking={false}
                onPick={noop}
                onOpenFocus={onOpenFocus}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Open focus map' }));
        expect(onOpenFocus).toHaveBeenCalledExactlyOnceWith('bbox-42');
    });
});

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { makePoi } from '../test/fixtures';
import { detectPlaceType, PlaceTypeSelect } from './PlaceTypeSelect';

describe('detectPlaceType', () => {
    it.each([
        [{ amenity: 'university' }, 'university'],
        [{ education: 'university' }, 'university'],
        [{ building: 'university' }, 'university'],
        [{ amenity: 'college' }, 'cegep'],
        [{ education: 'college' }, 'cegep'],
        [{ amenity: 'hospital' }, 'hospital'],
        [{ healthcare: 'hospital' }, 'hospital'],
        [{ building: 'industrial' }, 'industrial'],
        [{ man_made: 'works' }, 'industrial'],
        [{ leisure: 'park' }, 'park'],
        [{ shop: 'bakery' }, null],
        [{}, null],
    ] as const)('classifies %o as %s', (tags, expected) => {
        expect(detectPlaceType({ ...tags })).toBe(expected);
    });
});

describe('<PlaceTypeSelect />', () => {
    it('preselects the detected type when no stored choice exists', () => {
        render(
            <PlaceTypeSelect
                poi={makePoi({ tags: { amenity: 'university' } })}
                placeType={null}
                onChange={() => {}}
            />,
        );
        const select = screen.getByLabelText(/Place type/) as HTMLSelectElement;
        expect(select.value).toBe('university');
        expect(screen.getByText('University (detected)')).toBeInTheDocument();
    });

    it('prefers the stored choice over the detected type', () => {
        render(
            <PlaceTypeSelect
                poi={makePoi({ tags: { amenity: 'university' } })}
                placeType="park"
                onChange={() => {}}
            />,
        );
        expect((screen.getByLabelText(/Place type/) as HTMLSelectElement).value).toBe('park');
    });

    it('stays empty for unclassifiable tags and reports changes (null on clear)', () => {
        const onChange = vi.fn();
        render(
            <PlaceTypeSelect
                poi={makePoi({ tags: { shop: 'bakery' } })}
                placeType={null}
                onChange={onChange}
            />,
        );
        const select = screen.getByLabelText(/Place type/) as HTMLSelectElement;
        expect(select.value).toBe('');
        fireEvent.change(select, { target: { value: 'hospital' } });
        expect(onChange).toHaveBeenCalledExactlyOnceWith('hospital');
        fireEvent.change(select, { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
});

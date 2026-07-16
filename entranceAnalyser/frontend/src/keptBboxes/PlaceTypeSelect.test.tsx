/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { makePoi } from '../test/fixtures';
import { PlaceTypeSelect } from './PlaceTypeSelect';

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
                placeType="municipal_park"
                onChange={() => {}}
            />,
        );
        expect((screen.getByLabelText(/Place type/) as HTMLSelectElement).value).toBe(
            'municipal_park',
        );
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

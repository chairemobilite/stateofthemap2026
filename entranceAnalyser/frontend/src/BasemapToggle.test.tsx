import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { BasemapToggle } from './BasemapToggle';
import { BASEMAPS } from './basemaps';

describe('<BasemapToggle />', () => {
    it('renders one button per basemap with the active one pressed', () => {
        render(<BasemapToggle basemaps={BASEMAPS} activeId="osm" onChange={() => {}} />);

        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(BASEMAPS.length);

        expect(screen.getByRole('button', { name: 'OSM' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Aerial (ESRI)' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('calls onChange with the clicked basemap id', () => {
        const onChange = vi.fn();
        render(<BasemapToggle basemaps={BASEMAPS} activeId="osm" onChange={onChange} />);

        fireEvent.click(screen.getByRole('button', { name: 'Aerial (ESRI)' }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('esri-imagery');
    });
});

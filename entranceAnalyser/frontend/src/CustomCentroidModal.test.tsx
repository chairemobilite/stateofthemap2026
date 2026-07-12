/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CustomCentroidModal } from './CustomCentroidModal';

describe('<CustomCentroidModal />', () => {
    it('does not render when closed', () => {
        render(
            <CustomCentroidModal
                open={false}
                onClose={vi.fn()}
                onApplyLatLon={vi.fn()}
                onApplyOsmRef={vi.fn()}
                busy={false}
            />,
        );
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('calls onApply with parsed coordinates and closes on success', async () => {
        const onClose = vi.fn();
        const onApplyLatLon = vi.fn().mockResolvedValue(true);
        render(
            <CustomCentroidModal
                open
                onClose={onClose}
                onApplyLatLon={onApplyLatLon}
                onApplyOsmRef={vi.fn()}
                busy={false}
            />,
        );

        fireEvent.change(screen.getByRole('textbox', { name: /Latitude, longitude/i }), {
            target: { value: '45.5, -73.5' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        await waitFor(() => expect(onApplyLatLon).toHaveBeenCalledExactlyOnceWith(45.5, -73.5));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('shows validation error for non-numeric input', async () => {
        const onApplyLatLon = vi.fn();
        render(
            <CustomCentroidModal
                open
                onClose={vi.fn()}
                onApplyLatLon={onApplyLatLon}
                onApplyOsmRef={vi.fn()}
                busy={false}
            />,
        );

        fireEvent.change(screen.getByRole('textbox', { name: /Latitude, longitude/i }), {
            target: { value: 'x, 1' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(await screen.findByText(/numeric latitude/)).toBeInTheDocument();
        expect(onApplyLatLon).not.toHaveBeenCalled();
    });

    it('calls onApplyOsmRef when OSM field is filled (priority over coords)', async () => {
        const onApplyOsmRef = vi.fn().mockResolvedValue(true);
        const onApplyLatLon = vi.fn();
        render(
            <CustomCentroidModal
                open
                onClose={vi.fn()}
                onApplyLatLon={onApplyLatLon}
                onApplyOsmRef={onApplyOsmRef}
                busy={false}
            />,
        );
        fireEvent.change(screen.getByRole('textbox', { name: /Latitude, longitude/i }), {
            target: { value: '1, 2' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: /OSM node/i }), {
            target: { value: 'node/42' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
        await waitFor(() => expect(onApplyOsmRef).toHaveBeenCalledExactlyOnceWith('node/42'));
        expect(onApplyLatLon).not.toHaveBeenCalled();
    });

    it('clears both fields when the dialog reopens', async () => {
        const props = {
            onClose: vi.fn(),
            onApplyLatLon: vi.fn().mockResolvedValue(true),
            onApplyOsmRef: vi.fn().mockResolvedValue(true),
            busy: false,
        };
        const { rerender } = render(<CustomCentroidModal open {...props} />);

        fireEvent.change(screen.getByRole('textbox', { name: /Latitude, longitude/i }), {
            target: { value: '1, 2' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: /OSM node/i }), {
            target: { value: 'node/99' },
        });

        rerender(<CustomCentroidModal open={false} {...props} />);
        rerender(<CustomCentroidModal open {...props} />);

        expect(screen.getByRole('textbox', { name: /Latitude, longitude/i })).toHaveValue('');
        expect(screen.getByRole('textbox', { name: /OSM node/i })).toHaveValue('');
    });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
    MapContextMenu,
    type MapContextMenuItem,
    type MapContextMenuProps,
} from './MapContextMenu';

const ITEMS: MapContextMenuItem[] = [
    { key: 'mapillary', label: 'Mapillary', href: 'https://example.org/m' },
    { key: 'osm', label: 'OpenStreetMap', href: 'https://example.org/o' },
];

function renderMenu(overrides: Partial<MapContextMenuProps> = {}) {
    const props: MapContextMenuProps = {
        position: { x: 100, y: 50 },
        items: ITEMS,
        onDismiss: () => {},
        ...overrides,
    };
    return render(<MapContextMenu {...props} />);
}

describe('<MapContextMenu />', () => {
    it('renders nothing when position is null', () => {
        const { container } = renderMenu({ position: null });
        expect(container.firstChild).toBeNull();
    });

    it('renders a menu role at the requested position', () => {
        renderMenu({ position: { x: 120, y: 60 } });
        const menu = screen.getByRole('menu');
        expect(menu).toBeInTheDocument();
        const style = (menu as HTMLElement).style;
        expect(style.left).toBe('120px');
        expect(style.top).toBe('60px');
    });

    it.each(ITEMS)(
        'renders item $label as a target=_blank link to $href with rel=noopener',
        ({ label, href }) => {
            renderMenu();
            const link = screen.getByRole('menuitem', { name: label }) as HTMLAnchorElement;
            expect(link.getAttribute('href')).toBe(href);
            expect(link.getAttribute('target')).toBe('_blank');
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        },
    );

    it('calls onDismiss when an item is clicked', () => {
        const onDismiss = vi.fn();
        renderMenu({ onDismiss });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Mapillary' }));
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('calls onDismiss on click outside the menu', () => {
        const onDismiss = vi.fn();
        renderMenu({ onDismiss });
        fireEvent.mouseDown(document.body);
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('does not call onDismiss when the user clicks inside the menu', () => {
        const onDismiss = vi.fn();
        renderMenu({ onDismiss });
        fireEvent.mouseDown(screen.getByRole('menu'));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('calls onDismiss on Escape key', () => {
        const onDismiss = vi.fn();
        renderMenu({ onDismiss });
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('does not register listeners when position is null', () => {
        const onDismiss = vi.fn();
        renderMenu({ position: null, onDismiss });
        fireEvent.mouseDown(document.body);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onDismiss).not.toHaveBeenCalled();
    });
});

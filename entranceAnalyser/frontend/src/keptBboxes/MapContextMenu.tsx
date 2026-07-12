/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Right-click context menu rendered over the focus map.
//!
//! Pure presentational: the parent decides where the menu sits
//! (`position`, in container-local CSS pixels) and what items it
//! contains (`items`, already-built URLs from `mapLinks.ts`). The
//! component handles the small but fiddly bits — click-outside and
//! Esc dismissal, item-click dismissal, and the `target=_blank` /
//! `rel=noopener` boilerplate — so call sites stay tiny.
//!
//! When `position` is `null` the component renders nothing. Mounting
//! is therefore controlled entirely by the presence of a position,
//! which keeps the parent's state model trivial: one nullable
//! `{ x, y }` plus the items array.

import { useEffect, useRef } from 'react';

/** One menu row. `key` should be a stable identifier (e.g. the
 *  service name) so React reconciliation works across re-renders. */
export type MapContextMenuItem =
    | { key: string; label: string; href: string }
    | { key: string; label: string; onSelect: () => void };

export interface MapContextMenuProps {
    /** CSS-pixel offset relative to the menu's positioned ancestor.
     *  `null` hides the menu entirely. */
    position: { x: number; y: number } | null;
    items: MapContextMenuItem[];
    /** Called when the user dismisses the menu (click outside, Esc,
     *  or after activating an item). The parent is expected to set
     *  `position` back to `null` in response. */
    onDismiss: () => void;
}

/** Render the menu when `position` is non-null. Each item is an
 *  `<a target="_blank">` so middle-click / cmd-click "open in
 *  background tab" works exactly like in the rest of the browser. */
export function MapContextMenu({ position, items, onDismiss }: MapContextMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (position === null) return;

        const handleMouseDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onDismiss();
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onDismiss();
        };
        // `mousedown` rather than `click` so the menu disappears as
        // soon as the user starts a click elsewhere — feels snappier
        // and matches the OS-level context-menu convention.
        document.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [position, onDismiss]);

    if (position === null) return null;

    return (
        <div
            ref={menuRef}
            className="map-context-menu"
            role="menu"
            style={{ left: position.x, top: position.y }}
        >
            <ul className="map-context-menu__list">
                {items.map((item) => (
                    <li key={item.key} role="none">
                        {'href' in item ? (
                            <a
                                role="menuitem"
                                className="map-context-menu__item"
                                href={item.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={onDismiss}
                            >
                                {item.label}
                            </a>
                        ) : (
                            <button
                                type="button"
                                role="menuitem"
                                className="map-context-menu__item"
                                onClick={() => {
                                    item.onSelect();
                                    onDismiss();
                                }}
                            >
                                {item.label}
                            </button>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PoiListPage } from './PoiListPage';
import type { KeptBbox, Poi, PoiPickEntry } from './api';

function makeBbox(id: string, lon: number, lat: number): KeptBbox {
    return {
        id,
        west: lon - 0.01,
        south: lat - 0.01,
        east: lon + 0.01,
        north: lat + 0.01,
        center: [lon, lat],
        cell_size_km: 1,
        population: 100,
        density_per_km2: 100,
        max_density_ratio: 0.1,
        built_volume: 0,
        max_built_volume_ratio: 0,
        kept_at: '2026-01-01T00:00:00Z',
    };
}

function makePoi(name: string, osmId = 100): Poi {
    return {
        osm_type: 'way',
        osm_id: osmId,
        center: [-73.5, 45.5],
        tags: { name, amenity: 'university' },
        group: 'amenities',
    };
}

function makePick(poi: Poi, completed: boolean): PoiPickEntry {
    return { poi, completed, rejected: false, rejected_reason: null, place_type: null };
}

describe('<PoiListPage />', () => {
    const mtlBbox = makeBbox('bbox-mtl', -73.5673, 45.5017);
    const torBbox = makeBbox('bbox-tor', -79.3832, 43.6532);
    const mtlPoi = makePoi('UQAM');
    const torPoi = makePoi('Toronto Mall', 200);

    const baseProps = {
        keptBboxes: [mtlBbox, torBbox],
        picks: {
            'bbox-mtl': makePick(mtlPoi, false),
            'bbox-tor': makePick(torPoi, true),
        },
        savingDecision: new Set<string>(),
        onSetPickPlaceType: vi.fn(),
        onOpenPoiFocus: vi.fn(),
        osmEditorUrlTemplate: 'https://example.org/id/#map={zoom}/{lat}/{lon}',
    };

    it('defaults to Quebec scope and lists only Quebec POIs', () => {
        render(<PoiListPage {...baseProps} />);
        expect(screen.getByText('UQAM')).toBeInTheDocument();
        expect(screen.queryByText('Toronto Mall')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Québec \(1\)/ })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    it('switches to world scope', () => {
        render(<PoiListPage {...baseProps} />);
        fireEvent.click(screen.getByRole('button', { name: /World \(1\)/ }));
        expect(screen.getByText('Toronto Mall')).toBeInTheDocument();
        expect(screen.queryByText('UQAM')).not.toBeInTheDocument();
    });

    it('shows status pills and iD edit links', () => {
        render(<PoiListPage {...baseProps} />);
        expect(screen.getByText('Started')).toBeInTheDocument();
        const link = screen.getByRole('link', { name: 'Open in iD' });
        expect(link).toHaveAttribute(
            'href',
            'https://example.org/id/#map=20/45.5/-73.5&id=w100',
        );
    });

    it('opens focus map from a row action', () => {
        const onOpenPoiFocus = vi.fn();
        render(<PoiListPage {...baseProps} onOpenPoiFocus={onOpenPoiFocus} />);
        fireEvent.click(screen.getByRole('button', { name: 'Focus map' }));
        expect(onOpenPoiFocus).toHaveBeenCalledWith('bbox-mtl');
    });
});

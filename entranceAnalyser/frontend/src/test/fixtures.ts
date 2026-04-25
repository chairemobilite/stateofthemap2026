//! Shared test fixtures for the bbox shape so individual test files don't
//! need to repeat (or drift on) the field list.

import type { Bbox, KeptBbox, Poi } from '../api';

export function makeBbox(overrides: Partial<Bbox> = {}): Bbox {
    return {
        id: 'abcd1234-0000-0000-0000-000000000001',
        west: -73.6,
        south: 45.5,
        east: -73.5,
        north: 45.6,
        center: [-73.55, 45.55],
        cell_size_km: 10,
        population: 12_500,
        density_per_km2: 125,
        max_density_ratio: 0.05,
        built_volume: 500_000,
        max_built_volume_ratio: 0.25,
        ...overrides,
    };
}

/**
 * Kept-bbox fixture: reuses `makeBbox` and tacks on a `kept_at` timestamp,
 * matching the shape `GET /api/bbox/kept` returns.
 *
 * @param overrides - Fields to override on the base fixture.
 */
export function makeKeptBbox(overrides: Partial<KeptBbox> = {}): KeptBbox {
    return {
        ...makeBbox(overrides),
        kept_at: overrides.kept_at ?? '2026-04-23T12:00:00Z',
    };
}

/**
 * Sample picked POI. Keeps the same default shape Overpass returns
 * (`type`, `id`, `lat`, `lon`, `tags`) once mapped to the wire form
 * defined in `Poi`.
 *
 * @param overrides - Fields to override on the base fixture.
 */
export function makePoi(overrides: Partial<Poi> = {}): Poi {
    return {
        osm_type: 'node',
        osm_id: 1234,
        center: [-73.55, 45.55],
        tags: { shop: 'bakery', name: 'Pain' },
        group: 'shops',
        ...overrides,
    };
}

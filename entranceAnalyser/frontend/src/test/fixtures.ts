//! Shared test fixtures for the bbox shape so individual test files don't
//! need to repeat (or drift on) the field list.

import type { Bbox } from '../api';

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
        ...overrides,
    };
}

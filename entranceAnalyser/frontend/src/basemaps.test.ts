import { describe, it, expect } from 'vitest';
import type { RasterSourceSpecification } from 'maplibre-gl';

import { BASEMAPS, DEFAULT_BASEMAP_ID, findBasemap, type BasemapId } from './basemaps';

describe('BASEMAPS catalogue', () => {
    it('ships the expected ids in a deterministic order', () => {
        expect(BASEMAPS.map((b) => b.id)).toEqual(['osm', 'esri-imagery']);
    });

    it('uses OSM as the default basemap', () => {
        expect(findBasemap(DEFAULT_BASEMAP_ID)).toBeDefined();
    });

    it.each<[BasemapId, string]>([
        ['osm', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        ['esri-imagery', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    ])('exposes %s as a style-v8 raster source with the expected tile URL', (id, expectedTile) => {
        const basemap = findBasemap(id);
        expect(basemap).toBeDefined();
        const style = basemap!.style;
        expect(style.version).toBe(8);

        const source = style.sources[id] as RasterSourceSpecification;
        expect(source.type).toBe('raster');
        expect(source.tiles).toEqual([expectedTile]);
        // Attribution must be non-empty — OSM and ESRI both require it.
        expect(source.attribution ?? '').not.toBe('');

        expect(style.layers).toHaveLength(1);
        expect(style.layers[0].id).toBe(id);
        expect(style.layers[0].type).toBe('raster');
    });

    it('returns undefined for an unknown id (guarded typing allows runtime misses)', () => {
        expect(findBasemap('does-not-exist' as BasemapId)).toBeUndefined();
    });
});

import { describe, expect, it } from 'vitest';

import { parseOsmRef } from './customOsmRefParse';

describe('parseOsmRef', () => {
    it.each([
        ['node/1', 'node', 1],
        ['  way / 99 ', 'way', 99],
        ['relation/1000', 'relation', 1000],
    ] as const)('%j', (raw, ty, id) => {
        expect(parseOsmRef(raw)).toEqual({ osm_type: ty, osm_id: id });
    });

    it.each([
        ['', /Expected node/],
        ['nope', /Expected node/],
        ['node/', /positive integer/],
        ['building/1', /Type must be/],
    ] as const)('%j → error', (raw, pattern) => {
        expect(parseOsmRef(raw)).toMatchObject({ error: expect.stringMatching(pattern) });
    });
});

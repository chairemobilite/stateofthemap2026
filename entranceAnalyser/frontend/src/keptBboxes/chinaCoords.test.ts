import { describe, expect, it } from 'vitest';

import {
    gcj02ToBd09,
    outOfChina,
    wgs84ToBd09,
    wgs84ToGcj02,
    type LatLon,
} from './chinaCoords';

/** Tolerance for fixture comparisons: 1e-6 deg ≈ 0.1 m at mid-latitudes —
 *  tighter than any real Baidu/AMap marker rendering, slack enough to
 *  absorb floating-point noise across V8 versions. */
const EPS = 1e-6;

function expectClose([aLat, aLon]: LatLon, [bLat, bLon]: LatLon, eps = EPS): void {
    expect(aLat).toBeCloseTo(bLat, -Math.log10(eps));
    expect(aLon).toBeCloseTo(bLon, -Math.log10(eps));
}

describe('outOfChina', () => {
    it.each([
        ['Tian an men (Beijing)', 39.9093, 116.3974, false],
        ['Shanghai', 31.2304, 121.4737, false],
        ['Urumqi', 43.8256, 87.6168, false],
        ['Hainan (just inside)', 18.5, 109.0, false],
        ['Montreal', 45.5017, -73.5673, true],
        ['Paris', 48.8566, 2.3522, true],
        ['Tokyo (just outside east edge)', 35.6762, 139.6503, true],
        ['Equator south of Indonesia', 0.0, 100.0, true],
    ] as const)('%s → outOfChina = %s', (_label, lat, lon, expected) => {
        expect(outOfChina(lat, lon)).toBe(expected);
    });
});

describe('wgs84ToGcj02 / gcj02ToBd09 / wgs84ToBd09', () => {
    /**
     * Reference fixture for Tian'anmen Square, computed with the
     * `wandergis/coordtransform` Python reference implementation
     * (`gcj02_to_bd09` + `wgs84_to_gcj02`). Cross-checked against the
     * canonical README example `gcj02tobd09(116.404, 39.915) →
     * (116.41036949371029, 39.92133699351021)`. If our values drift
     * from these, the algorithm is wrong, not the fixture.
     */
    const TIANANMEN = {
        wgs84: [39.9093, 116.3974] as LatLon,
        gcj02: [39.910_703_503_167, 116.403_643_629_258] as LatLon,
        bd09: [39.917_042_930_046, 116.410_016_012_594] as LatLon,
    };

    it('matches the canonical Tian an men WGS84 → GCJ-02 fixture', () => {
        expectClose(wgs84ToGcj02(...TIANANMEN.wgs84), TIANANMEN.gcj02);
    });

    it('matches the canonical Tian an men GCJ-02 → BD09 fixture', () => {
        expectClose(gcj02ToBd09(...TIANANMEN.gcj02), TIANANMEN.bd09);
    });

    it('matches the canonical Tian an men WGS84 → BD09 fixture', () => {
        expectClose(wgs84ToBd09(...TIANANMEN.wgs84), TIANANMEN.bd09);
    });

    it('matches the coordtransform README example for gcj02ToBd09', () => {
        // From wandergis/coordtransform README, exact verbatim values:
        //   coordtransform.gcj02tobd09(116.404, 39.915)
        //   → [116.41036949371029, 39.92133699351021]
        // (the README quotes [lng, lat]; we feed [lat, lng]).
        expectClose(gcj02ToBd09(39.915, 116.404), [39.921_336_993_510, 116.410_369_493_710]);
    });

    it('wgs84ToBd09 equals the composition wgs84→gcj02→bd09', () => {
        const wgs: LatLon = [31.2304, 121.4737];
        const direct = wgs84ToBd09(...wgs);
        const composed = gcj02ToBd09(...wgs84ToGcj02(...wgs));
        expectClose(direct, composed);
    });

    it.each([
        ['Montreal', 45.5017, -73.5673],
        ['Paris', 48.8566, 2.3522],
        ['Tokyo', 35.6762, 139.6503],
    ] as const)('wgs84ToGcj02 returns %s unchanged (out of China)', (_label, lat, lon) => {
        expectClose(wgs84ToGcj02(lat, lon), [lat, lon]);
    });

    it('GCJ-02 offset stays within ~700 m anywhere in mainland China', () => {
        // Spot-check a handful of widely-separated points and assert
        // the magnitude of the offset. 700 m ≈ 0.0063 deg at the
        // equator; comfortably looser than the real-world worst case
        // (Xinjiang ≈ 0.005 deg) so the assertion catches gross
        // sign / scale bugs without being fragile.
        const POINTS: LatLon[] = [
            [39.9093, 116.3974],
            [31.2304, 121.4737],
            [22.3193, 114.1694],
            [43.8256, 87.6168],
        ];
        for (const [lat, lon] of POINTS) {
            const [gLat, gLon] = wgs84ToGcj02(lat, lon);
            expect(Math.abs(gLat - lat)).toBeLessThan(0.0063);
            expect(Math.abs(gLon - lon)).toBeLessThan(0.0063);
            expect(Math.abs(gLat - lat) + Math.abs(gLon - lon)).toBeGreaterThan(0); // sanity: it actually moved
        }
    });
});

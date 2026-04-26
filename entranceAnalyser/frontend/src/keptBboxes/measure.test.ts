import type { LngLatLike } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import {
    ANCHOR_UI_GUARD_PX,
    calculatePathLength,
    DEFAULT_WALKING_SPEED_KMH,
    estimateWalkingTimeMinutes,
    insertVertexAlongPolyline,
    MAX_WALKING_SPEED_KMH,
    MIN_WALKING_SPEED_KMH,
    parseWalkingSpeedInput,
    pixelDistance,
    snapClickToNearestAnchorPx,
} from './measure';

describe('measure utilities', () => {
    describe('calculatePathLength', () => {
        it.each([
            [[], 0],
            [[[0, 0]], 0],
            [
                [
                    [0, 0],
                    [0.001, 0],
                ],
                111, // ~111 m per 0.001° at equator
            ],
            [
            [
                [-73.9857, 40.7484], // Empire State
                [-73.9857, 40.7584], // ~1.11 km north
            ],
            1112,
            ],
        ] as const)('calculatePathLength(%j) = %i m', (points, expected) => {
            expect(calculatePathLength(points as unknown as LngLatLike[])).toBe(expected);
        });

        it('sums multiple segments correctly', () => {
            const points: LngLatLike[] = [
                [0, 0],
                [0.001, 0],
                [0.001, 0.001],
            ];
            // Two ~111m segments
            expect(calculatePathLength(points)).toBe(222);
        });
    });

    describe('estimateWalkingTimeMinutes', () => {
        it.each([
            [0, 5, 0],
            [1000, 5, 12], // 1 km @ 5 km/h = 12 min
            [600, 4, 9], // 0.6 km @ 4 km/h = 9 min
            [1500, DEFAULT_WALKING_SPEED_KMH, 18],
            [0, 0, 0],
            [1000, 0, 0],
        ] as const)(
            'estimateWalkingTimeMinutes(%i m, %i km/h) = %i min',
            (distance, speed, expected) => {
                expect(estimateWalkingTimeMinutes(distance, speed)).toBe(expected);
            },
        );
    });

    describe('parseWalkingSpeedInput', () => {
        it.each([
            ['5', 5],
            ['5.0', 5],
            [`${MIN_WALKING_SPEED_KMH}`, MIN_WALKING_SPEED_KMH],
            [`${MAX_WALKING_SPEED_KMH}`, MAX_WALKING_SPEED_KMH],
            ['  4.2  ', 4.2],
            ['', null],
            ['0', null],
            ['0.4', null],
            ['10.1', null],
            ['abc', null],
            ['-1', null],
        ] as const)('parseWalkingSpeedInput(%j) → %j', (raw, expected) => {
            expect(parseWalkingSpeedInput(raw)).toBe(expected);
        });
    });

    describe('insertVertexAlongPolyline', () => {
        it('returns null for fewer than two points', () => {
            expect(insertVertexAlongPolyline([], { lng: 0, lat: 0 })).toBeNull();
            expect(insertVertexAlongPolyline([[0, 0]], { lng: 0, lat: 0 })).toBeNull();
        });

        it.each([
            [
                [
                    [0, 0],
                    [0.002, 0],
                ] as [number, number][],
                { lng: 0.001, lat: 0 },
                1,
                [0.001, 0],
            ],
            [
                [
                    [-73.99, 45.5],
                    [-73.98, 45.5],
                ] as [number, number][],
                { lng: -73.985, lat: 45.5 },
                1,
                [-73.985, 45.5],
            ],
        ] as const)('snaps onto segment (insertIndex=%i)', (points, click, expectedIndex, expectedPos) => {
            const r = insertVertexAlongPolyline(points, click);
            expect(r).not.toBeNull();
            expect(r!.insertIndex).toBe(expectedIndex);
            expect(r!.position[0]).toBeCloseTo(expectedPos[0], 5);
            expect(r!.position[1]).toBeCloseTo(expectedPos[1], 5);
        });

        it('inserts on the second segment when the click is nearer to it', () => {
            const points: [number, number][] = [
                [0, 0],
                [0.002, 0],
                [0.002, 0.002],
            ];
            const r = insertVertexAlongPolyline(points, { lng: 0.002, lat: 0.001 });
            expect(r).not.toBeNull();
            expect(r!.insertIndex).toBe(2);
            expect(r!.position[0]).toBeCloseTo(0.002, 5);
            expect(r!.position[1]).toBeCloseTo(0.001, 5);
        });
    });

    describe('snapClickToNearestAnchorPx', () => {
        const project = (lon: number, lat: number) => ({ x: lon, y: lat });

        it('returns null when there are no targets', () => {
            expect(snapClickToNearestAnchorPx({ x: 0, y: 0 }, [], project, 8)).toBeNull();
        });

        it('returns null when every anchor is farther than maxPx', () => {
            expect(snapClickToNearestAnchorPx({ x: 0, y: 0 }, [[100, 0]] as [number, number][], project, 8)).toBeNull();
        });

        it('returns the nearest target within maxPx', () => {
            const targets: [number, number][] = [
                [-73, 45],
                [-72, 45],
            ];
            expect(snapClickToNearestAnchorPx({ x: -72.5, y: 45 }, targets, project, 8)).toEqual([-73, 45]);
        });

        it('uses ANCHOR_UI_GUARD_PX for focus-centre-style snap in screen space', () => {
            const center: [number, number] = [-73.5, 45.5];
            const centreScreen = project(center[0], center[1]);
            expect(
                snapClickToNearestAnchorPx(
                    { x: centreScreen.x + 5, y: centreScreen.y },
                    [center],
                    project,
                    ANCHOR_UI_GUARD_PX,
                ),
            ).toEqual(center);
            expect(
                snapClickToNearestAnchorPx(
                    { x: centreScreen.x + ANCHOR_UI_GUARD_PX, y: centreScreen.y },
                    [center],
                    project,
                    ANCHOR_UI_GUARD_PX,
                ),
            ).toEqual(center);
            expect(
                snapClickToNearestAnchorPx(
                    { x: centreScreen.x + ANCHOR_UI_GUARD_PX + 1, y: centreScreen.y },
                    [center],
                    project,
                    ANCHOR_UI_GUARD_PX,
                ),
            ).toBeNull();
        });
    });

    describe('pixelDistance', () => {
        it.each([
            [{ x: 0, y: 0 }, { x: 3, y: 4 }, 5],
            [{ x: 10, y: 10 }, { x: 10, y: 10 }, 0],
        ] as const)('from %j to %j = %i', (a, b, expected) => {
            expect(pixelDistance(a, b)).toBeCloseTo(expected, 5);
        });
    });
});

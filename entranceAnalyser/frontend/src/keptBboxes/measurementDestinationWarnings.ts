/**
 * Detect when polylines aimed at the same destination type (transit stop,
 * walking network, …) land on different endpoints depending on the
 * analyst's entrance-type anchor (main entrance vs building centroid, etc.).
 */

import type { PoiFocusMeasurement } from '../api';
import { haversineDistanceM } from './measure';
import type { EntranceType, MeasurementPurpose } from './measurementCatalog';
import { MEASUREMENT_PURPOSES } from './measurementCatalog';

/** Default when server config is still loading. Mirrors backend default. */
export const DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M = 10;

/** @deprecated Use {@link DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M}. */
export const MEASUREMENT_DESTINATION_MATCH_RADIUS_M = DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M;

/** Destination types compared across entrance anchors (entrance targets excluded). */
export const COMPARABLE_MEASUREMENT_PURPOSES = MEASUREMENT_PURPOSES.filter(
    (p) => p !== 'to_nearest_entrance' && p !== 'to_nearest_main_entrance',
) as readonly Exclude<
    MeasurementPurpose,
    'to_nearest_entrance' | 'to_nearest_main_entrance'
>[];

type ComparablePurpose = (typeof COMPARABLE_MEASUREMENT_PURPOSES)[number];

const DESTINATION_WARNING_LABELS: Record<ComparablePurpose, string> = {
    to_nearest_transit_stop: 'transit stop',
    to_nearest_walking_network: 'walking network',
    to_nearest_cycling_network: 'cycling network',
    to_nearest_parking: 'parking',
    to_nearest_driving_road: 'driving road',
    to_nearest_walking_cycling_network: 'walking + cycling network',
    to_nearest_walking_cycling_driving_network: 'walking + cycling + driving network',
    to_nearest_walking_driving_network: 'walking + driving network',
};

const ENTRANCE_TYPE_WARNING_LABELS: Record<EntranceType, string> = {
    main: 'main entrance',
    customers: 'customers entrance',
    home: 'home entrance',
    emergency: 'emergency entrance',
    service_employees: 'service (employees) entrance',
    service_delivery: 'service (delivery) entrance',
    garage: 'garage entrance',
    centroid_main_building: 'main building centroid',
    centroid_multiple_buildings: 'multiple-buildings centroid',
    centroid_area: 'area centroid',
    centroid_parcel: 'parcel centroid',
    other: 'other entrance',
};

/** Last vertex of a saved polyline — the analyst-marked destination. */
export function measurementEndpoint(
    coordinates: ReadonlyArray<readonly [number, number]>,
): [number, number] | null {
    if (coordinates.length === 0) return null;
    const last = coordinates[coordinates.length - 1];
    return [last[0], last[1]];
}

function isComparablePurpose(p: MeasurementPurpose): p is ComparablePurpose {
    return (COMPARABLE_MEASUREMENT_PURPOSES as readonly string[]).includes(p);
}

/**
 * Human-readable warnings for every entrance-type pair whose endpoints
 * disagree on the same destination type beyond `matchRadiusM`.
 */
export function findMeasurementDestinationMismatches(
    measurements: readonly PoiFocusMeasurement[],
    matchRadiusM: number = DEFAULT_MEASUREMENT_DESTINATION_MATCH_RADIUS_M,
): string[] {
    const latestByPurposeAndEntrance = new Map<string, PoiFocusMeasurement>();

    for (const m of measurements) {
        if (!isComparablePurpose(m.measurement_type)) continue;
        if (m.coordinates.length === 0) continue;
        const key = `${m.measurement_type}\0${m.entrance_type}`;
        const prev = latestByPurposeAndEntrance.get(key);
        if (!prev || m.created_at > prev.created_at) {
            latestByPurposeAndEntrance.set(key, m);
        }
    }

    const warnings: string[] = [];

    for (const purpose of COMPARABLE_MEASUREMENT_PURPOSES) {
        const byEntrance = new Map<EntranceType, [number, number]>();
        for (const [key, m] of latestByPurposeAndEntrance) {
            if (!key.startsWith(`${purpose}\0`)) continue;
            const endpoint = measurementEndpoint(m.coordinates);
            if (!endpoint) continue;
            byEntrance.set(m.entrance_type, endpoint);
        }

        const entranceTypes = [...byEntrance.keys()].sort();
        for (let i = 0; i < entranceTypes.length; i++) {
            for (let j = i + 1; j < entranceTypes.length; j++) {
                const a = entranceTypes[i];
                const b = entranceTypes[j];
                const endA = byEntrance.get(a)!;
                const endB = byEntrance.get(b)!;
                const dist = haversineDistanceM(endA[0], endA[1], endB[0], endB[1]);
                if (dist > matchRadiusM) {
                    const dest = DESTINATION_WARNING_LABELS[purpose];
                    const labelA = ENTRANCE_TYPE_WARNING_LABELS[a];
                    const labelB = ENTRANCE_TYPE_WARNING_LABELS[b];
                    warnings.push(
                        `The nearest ${dest} is not the same for ${labelA} and ${labelB}`,
                    );
                }
            }
        }
    }

    return warnings;
}

/** One POI row from `GET …/poi_focus_measurement_destination_warnings`. */
export interface DestinationWarningRow {
    bbox_id: string;
    warnings: string[];
}

/** Warnings grouped by message text for the Stats page. */
export interface AggregatedDestinationWarning {
    message: string;
    bbox_ids: string[];
}

/**
 * Invert per-POI warnings into one row per unique message, sorted by
 * descending POI count then message text.
 */
export function aggregateDestinationWarningsByMessage(
    rows: readonly DestinationWarningRow[],
): AggregatedDestinationWarning[] {
    const byMessage = new Map<string, Set<string>>();
    for (const row of rows) {
        for (const message of row.warnings) {
            let ids = byMessage.get(message);
            if (!ids) {
                ids = new Set();
                byMessage.set(message, ids);
            }
            ids.add(row.bbox_id);
        }
    }
    return [...byMessage.entries()]
        .map(([message, ids]) => ({
            message,
            bbox_ids: [...ids].sort(),
        }))
        .sort(
            (a, b) =>
                b.bbox_ids.length - a.bbox_ids.length || a.message.localeCompare(b.message),
        );
}

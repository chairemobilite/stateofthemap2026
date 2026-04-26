/**
 * Allowed `measurement_type` / `entrance_type` wire values for POI focus
 * measurements (mirrors Postgres CHECK + Rust enums in
 * `backend/src/focus_measurements.rs`).
 */

export const MEASUREMENT_PURPOSES = [
    'to_nearest_transit_stop',
    'to_nearest_entrance',
    'to_nearest_main_entrance',
    'to_nearest_walking_network',
    'to_nearest_cycling_network',
    'to_nearest_parking',
    'to_nearest_driving_road',
    'to_nearest_walking_cycling_network',
    'to_nearest_walking_cycling_driving_network',
    'to_nearest_walking_driving_network',
] as const;

export type MeasurementPurpose = (typeof MEASUREMENT_PURPOSES)[number];

export const ENTRANCE_TYPES = [
    'main',
    'customers',
    'home',
    'emergency',
    'service_employees',
    'service_delivery',
    'garage',
    'centroid_main_building',
    'centroid_multiple_buildings',
    'centroid_area',
    'centroid_parcel',
    'other',
] as const;

export type EntranceType = (typeof ENTRANCE_TYPES)[number];

/** `true` when `v` is a valid API / select value (not the empty placeholder). */
export function isMeasurementPurpose(v: string): v is MeasurementPurpose {
    return (MEASUREMENT_PURPOSES as readonly string[]).includes(v);
}

/** `true` when `v` is a valid API / select value (not the empty placeholder). */
export function isEntranceType(v: string): v is EntranceType {
    return (ENTRANCE_TYPES as readonly string[]).includes(v);
}

/** UI label for each `measurement_type` value. */
export const MEASUREMENT_PURPOSE_LABELS: Record<MeasurementPurpose, string> = {
    to_nearest_transit_stop: 'To nearest transit stop',
    to_nearest_entrance: 'To nearest entrance',
    to_nearest_main_entrance: 'To nearest main entrance',
    to_nearest_walking_network: 'To nearest walking network',
    to_nearest_cycling_network: 'To nearest cycling network',
    to_nearest_parking: 'To nearest parking',
    to_nearest_driving_road: 'To nearest driving road',
    to_nearest_walking_cycling_network: 'To nearest walking + cycling network',
    to_nearest_walking_cycling_driving_network:
        'To nearest walking + cycling + driving network',
    to_nearest_walking_driving_network: 'To nearest walking + driving network',
};

/** UI label for each `entrance_type` value. */
export const ENTRANCE_TYPE_LABELS: Record<EntranceType, string> = {
    main: 'Main',
    customers: 'Customers',
    home: 'Home',
    emergency: 'Emergency',
    service_employees: 'Service (employees)',
    service_delivery: 'Service (delivery)',
    garage: 'Garage',
    centroid_main_building: 'Centroid (main building)',
    centroid_multiple_buildings: 'Centroid (multiple buildings)',
    centroid_area: 'Centroid (area)',
    centroid_parcel: 'Centroid (parcel)',
    other: 'Other',
};

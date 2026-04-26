-- Rename measurement purposes + extend allowed set (see focus_measurements.rs / measurementCatalog.ts).

ALTER TABLE poi_focus_measurements
    DROP CONSTRAINT IF EXISTS poi_focus_measurements_measurement_type_chk;

UPDATE poi_focus_measurements
SET measurement_type = 'to_nearest_walking_network'
WHERE measurement_type = 'to_nearest_pedestrian_network';

UPDATE poi_focus_measurements
SET measurement_type = 'to_nearest_driving_road'
WHERE measurement_type = 'to_nearest_vehicle_road';

ALTER TABLE poi_focus_measurements
    ALTER COLUMN measurement_type SET DEFAULT 'to_nearest_walking_network';

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_measurement_type_chk
        CHECK (measurement_type IN (
            'to_nearest_transit_stop',
            'to_nearest_walking_network',
            'to_nearest_cycling_network',
            'to_nearest_parking',
            'to_nearest_driving_road',
            'to_nearest_walking_cycling_network',
            'to_nearest_walking_cycling_driving_network',
            'to_nearest_walking_driving_network'
        ));

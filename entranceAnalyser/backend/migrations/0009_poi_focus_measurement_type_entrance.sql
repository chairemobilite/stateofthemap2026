-- Add purpose for polylines drawn from centroid (or other anchor) toward the nearest entrance.

ALTER TABLE poi_focus_measurements
    DROP CONSTRAINT IF EXISTS poi_focus_measurements_measurement_type_chk;

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_measurement_type_chk
        CHECK (measurement_type IN (
            'to_nearest_transit_stop',
            'to_nearest_entrance',
            'to_nearest_walking_network',
            'to_nearest_cycling_network',
            'to_nearest_parking',
            'to_nearest_driving_road',
            'to_nearest_walking_cycling_network',
            'to_nearest_walking_cycling_driving_network',
            'to_nearest_walking_driving_network'
        ));

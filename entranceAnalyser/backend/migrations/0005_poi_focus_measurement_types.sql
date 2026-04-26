-- What the polyline measures toward + OSM-style entrance role (focus map tool).

ALTER TABLE poi_focus_measurements
    ADD COLUMN measurement_type TEXT NOT NULL DEFAULT 'to_nearest_pedestrian_network',
    ADD COLUMN entrance_type TEXT NOT NULL DEFAULT 'main';

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_measurement_type_chk
        CHECK (measurement_type IN (
            'to_nearest_transit_stop',
            'to_nearest_pedestrian_network',
            'to_nearest_cycling_network',
            'to_nearest_parking',
            'to_nearest_vehicle_road'
        ));

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_entrance_type_chk
        CHECK (entrance_type IN (
            'main',
            'customers',
            'home',
            'emergency',
            'service_employees',
            'service_delivery',
            'garage',
            'other'
        ));

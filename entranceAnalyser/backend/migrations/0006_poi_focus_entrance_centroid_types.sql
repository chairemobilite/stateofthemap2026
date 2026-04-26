-- Extend allowed `entrance_type` values (centroid-based anchors).

ALTER TABLE poi_focus_measurements
    DROP CONSTRAINT poi_focus_measurements_entrance_type_chk;

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
            'other',
            'centroid_main_building',
            'centroid_multiple_buildings',
            'centroid_area',
            'centroid_parcel'
        ));

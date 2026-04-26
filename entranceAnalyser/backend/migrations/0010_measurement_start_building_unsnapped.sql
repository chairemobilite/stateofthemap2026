-- Allow first-vertex anchors on a building polygon centroid (OSM way id)
-- and explicitly unsnapped starts when no entrance / centroid snap applies.

ALTER TABLE poi_focus_measurements
    DROP CONSTRAINT IF EXISTS poi_focus_measurements_start_osm_consistency_chk;

ALTER TABLE poi_focus_measurements
    DROP CONSTRAINT IF EXISTS poi_focus_measurements_start_origin_chk;

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_start_origin_chk
    CHECK (start_origin IN (
        'poi_focus_centroid',
        'osm_entrance',
        'legacy_unknown',
        'building_centroid',
        'unsnapped_start'
    ));

-- poi_focus_centroid / legacy_unknown / unsnapped_start: no id.
-- osm_entrance: OSM entrance node id.
-- building_centroid: OSM building **way** id (same bigint column; analytics use start_origin).
ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_start_osm_consistency_chk
    CHECK (
        (start_origin = 'poi_focus_centroid' AND start_osm_node_id IS NULL)
        OR (start_origin = 'osm_entrance' AND start_osm_node_id IS NOT NULL)
        OR (start_origin = 'legacy_unknown' AND start_osm_node_id IS NULL)
        OR (start_origin = 'building_centroid' AND start_osm_node_id IS NOT NULL)
        OR (start_origin = 'unsnapped_start' AND start_osm_node_id IS NULL)
    );

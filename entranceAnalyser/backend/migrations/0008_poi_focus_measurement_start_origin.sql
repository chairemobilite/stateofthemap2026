-- Whether the first vertex is anchored on the POI/focus centroid or an
-- OSM entrance node (for downstream analytics).

ALTER TABLE poi_focus_measurements
    ADD COLUMN start_origin text NOT NULL DEFAULT 'legacy_unknown',
    ADD COLUMN start_osm_node_id bigint;

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_start_origin_chk
    CHECK (start_origin IN ('poi_focus_centroid', 'osm_entrance', 'legacy_unknown'));

ALTER TABLE poi_focus_measurements
    ADD CONSTRAINT poi_focus_measurements_start_osm_consistency_chk
    CHECK (
        (start_origin = 'poi_focus_centroid' AND start_osm_node_id IS NULL)
        OR (start_origin = 'osm_entrance' AND start_osm_node_id IS NOT NULL)
        OR (start_origin = 'legacy_unknown')
    );

CREATE INDEX poi_focus_measurements_start_origin_idx
    ON poi_focus_measurements (start_origin);

CREATE INDEX poi_focus_measurements_start_osm_node_id_idx
    ON poi_focus_measurements (start_osm_node_id)
    WHERE start_osm_node_id IS NOT NULL;

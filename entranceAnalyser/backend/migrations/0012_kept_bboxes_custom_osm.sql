-- Custom bbox from an explicit OSM node/way/relation (centre from Overpass `out center`).

ALTER TABLE kept_bboxes DROP CONSTRAINT IF EXISTS kept_bboxes_candidate_source_check;

ALTER TABLE kept_bboxes
    ADD CONSTRAINT kept_bboxes_candidate_source_check
        CHECK (candidate_source IN ('random', 'custom_centroid', 'custom_osm'));

ALTER TABLE kept_bboxes
    ADD COLUMN custom_osm_type text NULL,
    ADD COLUMN custom_osm_id bigint NULL;

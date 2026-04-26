-- Distinguish cells kept from random grid draws vs the custom-centroid tool.

ALTER TABLE kept_bboxes
    ADD COLUMN candidate_source text NOT NULL DEFAULT 'random'
        CHECK (candidate_source IN ('random', 'custom_centroid'));

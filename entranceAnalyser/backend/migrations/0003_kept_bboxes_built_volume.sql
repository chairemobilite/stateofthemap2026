-- Persist the built-volume context on kept bboxes so downstream
-- analyses can retrospectively ask "were our kept bboxes biased toward
-- residential or built areas?". Existing rows keep 0 until a new
-- decision is recorded.

ALTER TABLE kept_bboxes
    ADD COLUMN built_volume            DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN max_built_volume_ratio  DOUBLE PRECISION NOT NULL DEFAULT 0;

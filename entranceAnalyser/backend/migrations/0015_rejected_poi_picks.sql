-- Tombstones for rejected bboxes. Deleting a kept bbox (the "reject"
-- action) cascade-deletes its analyses rows, which used to erase all
-- trace of the rejection — making "how many rejects per country" stats
-- impossible. From now on `PgStore::remove_kept` copies the bbox (and
-- its POI pick, when one existed) here, in the same transaction as the
-- DELETE.
--
-- No FK on purpose: the referenced bbox is gone by design.
CREATE TABLE rejected_poi_picks (
    id              BIGSERIAL PRIMARY KEY,
    bbox_id         UUID NOT NULL UNIQUE,
    -- Bbox centre, used for point-in-polygon country stats.
    center_lon      DOUBLE PRECISION NOT NULL,
    center_lat      DOUBLE PRECISION NOT NULL,
    -- Full `Poi` JSON as it was at rejection time (center, tags,
    -- group). NULL when the bbox was rejected before a POI was picked.
    poi             JSONB,
    -- NULL for rows backfilled from a backup where the reason was lost.
    rejected_reason TEXT,
    rejected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

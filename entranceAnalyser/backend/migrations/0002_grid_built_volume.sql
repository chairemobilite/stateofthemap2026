-- Dual-weight sampling: add GHS-BUILT-V alongside GHS-POP so the sampler
-- can draw bboxes that capture non-residential buildings (ports,
-- industrial parks, campuses) that `pop`-only weights would ignore.
--
-- Existing grid_cells rows keep built_volume = 0 until `build-grid` is
-- re-run with `--built-volume`; that's also why `grid_meta` gets its
-- new columns with DEFAULT 0 rather than NOT NULL-without-default.

ALTER TABLE grid_cells
    ADD COLUMN built_volume REAL NOT NULL DEFAULT 0;

-- Cached per-grid totals so the runtime sampler can compose the
-- normalized blended weight (pop/total_pop + built/total_built) without
-- re-summing ~800k rows on every draw.
ALTER TABLE grid_meta
    ADD COLUMN total_pop        DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN total_built      DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN max_built_volume REAL             NOT NULL DEFAULT 0;

-- Entrance Analyser schema, v1.
--
-- Two persistence concerns live here:
--   1. The pre-aggregated GHS-POP world grid (`grid_meta` + `grid_cells`),
--      produced by the offline `entrance-analyser-build-grid` binary and
--      sampled from at runtime by `/api/bbox/random`.
--   2. The operator's accept/reject decisions (`kept_bboxes`) plus a
--      generic `analyses` side-table where entrance counts and other
--      derived measurements will land as the paper's analysis pipeline
--      grows.
--
-- Both tables carry a PostGIS `geom` column in EPSG:4326 so we can run
-- spatial queries later (e.g. "all kept bboxes within country X").

CREATE EXTENSION IF NOT EXISTS postgis;

-- One row per (cell_size_km, epoch) combination. Keeps global statistics
-- we compute at build time so the HTTP layer doesn't have to re-scan the
-- whole `grid_cells` table.
CREATE TABLE grid_meta (
    cell_size_km INTEGER  NOT NULL,
    epoch        SMALLINT NOT NULL,
    max_pop      REAL     NOT NULL,
    built_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cell_size_km, epoch)
);

-- One row per inhabited super-cell. `geom` is the cell centroid; the
-- on-the-fly bbox is built from (lat, lon, cell_size_km) at request time.
CREATE TABLE grid_cells (
    id           BIGSERIAL PRIMARY KEY,
    cell_size_km INTEGER  NOT NULL,
    epoch        SMALLINT NOT NULL,
    lat          REAL NOT NULL,
    lon          REAL NOT NULL,
    pop          REAL NOT NULL,
    geom         GEOMETRY(Point, 4326) NOT NULL,
    FOREIGN KEY (cell_size_km, epoch) REFERENCES grid_meta(cell_size_km, epoch) ON DELETE CASCADE
);
CREATE INDEX grid_cells_cs_epoch_idx ON grid_cells (cell_size_km, epoch);
CREATE INDEX grid_cells_geom_gist    ON grid_cells USING GIST (geom);

-- Operator-accepted candidate bboxes. The UUID is minted by the server
-- when the bbox is emitted and echoed back on the keep decision.
CREATE TABLE kept_bboxes (
    id                UUID PRIMARY KEY,
    west              DOUBLE PRECISION NOT NULL,
    south             DOUBLE PRECISION NOT NULL,
    east              DOUBLE PRECISION NOT NULL,
    north             DOUBLE PRECISION NOT NULL,
    center_lon        DOUBLE PRECISION NOT NULL,
    center_lat        DOUBLE PRECISION NOT NULL,
    cell_size_km      INTEGER NOT NULL,
    population        DOUBLE PRECISION NOT NULL,
    density_per_km2   DOUBLE PRECISION NOT NULL,
    max_density_ratio DOUBLE PRECISION NOT NULL,
    geom              GEOMETRY(Polygon, 4326) NOT NULL,
    kept_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kept_bboxes_geom_gist ON kept_bboxes USING GIST (geom);

-- Generic results table for per-bbox analyses (entrance counts today,
-- anything else tomorrow). `value` is the primary numeric output, `payload`
-- can hold richer structures without schema changes.
CREATE TABLE analyses (
    id         BIGSERIAL PRIMARY KEY,
    bbox_id    UUID NOT NULL REFERENCES kept_bboxes(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    value      DOUBLE PRECISION,
    payload    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (bbox_id, kind)
);
CREATE INDEX analyses_kind_idx ON analyses (kind);

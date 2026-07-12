-- Administrative boundaries used to resolve the country (and Quebec
-- membership) of each picked POI at stats-query time. The table is
-- empty after migration; populate it with
-- `backend/scripts/load_admin_boundaries.sh` (Natural Earth 1:10m).
--
-- `level` is either:
--   * 'country' — one row per country, `iso_code` = ISO 3166-1 alpha-2;
--   * 'region'  — sub-national polygons treated specially in the stats
--     (today only Quebec, `iso_code` = 'CA-QC').
CREATE TABLE admin_boundaries (
    id       BIGSERIAL PRIMARY KEY,
    level    TEXT NOT NULL CHECK (level IN ('country', 'region')),
    iso_code TEXT NOT NULL,
    name     TEXT NOT NULL,
    geom     GEOMETRY(MultiPolygon, 4326) NOT NULL,
    UNIQUE (level, iso_code)
);
CREATE INDEX admin_boundaries_geom_gist ON admin_boundaries USING GIST (geom);

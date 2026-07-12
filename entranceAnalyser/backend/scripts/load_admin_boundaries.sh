#!/usr/bin/env bash
# Populate the `admin_boundaries` table (migration 0014) from Natural
# Earth 1:10m data:
#   * every country polygon  (level='country', iso_code = ISO 3166-1 alpha-2)
#   * the Quebec polygon     (level='region',  iso_code = 'CA-QC')
#
# Requires: ogr2ogr (GDAL), psql, curl, unzip.
#
# Connection: uses PG_CONNECTION_STRING_PREFIX + PG_DATABASE from the
# workspace .env (same convention as the backend), or pass a full URL:
#   ./load_admin_boundaries.sh [postgres://user:pass@host:port/db]
#
# Re-runnable: rows are replaced (DELETE + INSERT) inside one transaction.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -ge 1 ]]; then
    DB_URL="$1"
else
    # Same .env the backend reads (workspace root, two levels up).
    ENV_FILE="$SCRIPT_DIR/../../../.env"
    if [[ -f "$ENV_FILE" ]]; then
        # shellcheck disable=SC1090
        set -a; source "$ENV_FILE"; set +a
    fi
    : "${PG_CONNECTION_STRING_PREFIX:?set PG_CONNECTION_STRING_PREFIX or pass a database URL}"
    : "${PG_DATABASE:?set PG_DATABASE or pass a database URL}"
    DB_URL="${PG_CONNECTION_STRING_PREFIX}${PG_DATABASE}"
fi

for tool in ogr2ogr psql curl unzip; do
    command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

NE_BASE="https://naciscdn.org/naturalearth/10m/cultural"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fetch() { # fetch <basename> — download + unzip one Natural Earth shapefile
    local name="$1"
    echo "Downloading $name…"
    curl -fsSL "$NE_BASE/$name.zip" -o "$WORKDIR/$name.zip"
    unzip -qo "$WORKDIR/$name.zip" -d "$WORKDIR/$name"
}

fetch ne_10m_admin_0_countries
fetch ne_10m_admin_1_states_provinces

# Load into staging tables; the SRS is already EPSG:4326.
echo "Loading staging tables…"
ogr2ogr -f PostgreSQL "PG:$DB_URL" "$WORKDIR/ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp" \
    -nln ne_admin0_staging -overwrite -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom
ogr2ogr -f PostgreSQL "PG:$DB_URL" "$WORKDIR/ne_10m_admin_1_states_provinces/ne_10m_admin_1_states_provinces.shp" \
    -nln ne_admin1_staging -overwrite -nlt PROMOTE_TO_MULTI -lco GEOMETRY_NAME=geom \
    -where "iso_3166_2 = 'CA-QC'"

echo "Filling admin_boundaries…"
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM admin_boundaries;

-- Natural Earth uses '-99' for a few disputed ISO codes; iso_a2_eh is
-- the "extended homeland" fallback that fills most of them.
INSERT INTO admin_boundaries (level, iso_code, name, geom)
SELECT 'country',
       CASE WHEN iso_a2 = '-99' THEN iso_a2_eh ELSE iso_a2 END,
       name,
       ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))
FROM ne_admin0_staging
WHERE COALESCE(CASE WHEN iso_a2 = '-99' THEN iso_a2_eh ELSE iso_a2 END, '-99') <> '-99';

INSERT INTO admin_boundaries (level, iso_code, name, geom)
SELECT 'region', iso_3166_2, name,
       ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))
FROM ne_admin1_staging
WHERE iso_3166_2 = 'CA-QC';

DROP TABLE ne_admin0_staging;
DROP TABLE ne_admin1_staging;
COMMIT;

SELECT level, COUNT(*) AS boundaries FROM admin_boundaries GROUP BY level;
SQL

echo "Done."

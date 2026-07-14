/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Load the `admin_boundaries` table (countries + Quebec) from Natural
//! Earth 1:10m, the same "offline provisioning binary" pattern as
//! `entrance-analyser-build-grid`.
//!
//! ```sh
//! entrance-analyser-load-boundaries
//! ```
//!
//! Downloads the admin-0 (countries) GeoJSON from the official
//! `natural-earth-vector` repository, then rewrites `admin_boundaries`
//! in one transaction:
//! * `level='country'` — one row per ISO 3166-1 alpha-2 code (features
//!   sharing a code are merged with `ST_Union`, name of the largest kept);
//! * `level='region'`  — the Quebec polygon (`iso_code='CA-QC'`), used
//!   by the stats to flag POIs that will be analysed separately. It is
//!   read from the bundled `config/quebec_boundary.geojson` (a
//!   hand-corrected polygon: Natural Earth's admin-1 river boundary on
//!   the Ottawa side is coarse enough to push Gatineau POIs outside
//!   Quebec).
//!
//! Geometry parsing/validation is delegated to PostGIS
//! (`ST_GeomFromGeoJSON` + `ST_MakeValid`). Re-runnable: the table is
//! truncated inside the same transaction. Pass `--admin0-file` to
//! reuse a previously downloaded GeoJSON, `--quebec-file` to override
//! the bundled Quebec polygon.

use std::path::PathBuf;
use std::time::Instant;

use clap::Parser;
use entrance_analyser_backend::config::{self, DbKind};
use entrance_analyser_backend::db;
use serde_json::Value as JsonValue;
use sqlx::{PgPool, Postgres, Transaction};

const NE_BASE: &str =
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

/// CLI arguments. Defaults download from the official Natural Earth
/// GitHub mirror; local files skip the download entirely.
#[derive(Parser, Debug)]
#[command(
    version,
    about = "Load Natural Earth country + Quebec boundaries into admin_boundaries"
)]
struct Args {
    /// Target database URL. Defaults to `PG_CONNECTION_STRING_PREFIX + PG_DATABASE`
    /// from the environment (loaded from `.env` if present).
    #[arg(long)]
    database_url: Option<String>,

    /// Local ne_10m_admin_0_countries.geojson instead of downloading.
    #[arg(long)]
    admin0_file: Option<PathBuf>,

    /// Quebec polygon override (Feature or FeatureCollection GeoJSON).
    /// Defaults to the bundled `config/quebec_boundary.geojson`.
    #[arg(long)]
    quebec_file: Option<PathBuf>,
}

/// Bundled hand-corrected Quebec polygon (see module docs).
const DEFAULT_QUEBEC_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../config/quebec_boundary.geojson");

/// One feature staged for insertion: ISO code, display name, and the raw
/// GeoJSON geometry (parsed server-side by `ST_GeomFromGeoJSON`).
struct StagedBoundary {
    iso_code: String,
    name: String,
    geometry_json: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let started = Instant::now();

    config::load_dotenv();
    let database_url = match &args.database_url {
        Some(url) => url.clone(),
        None => config::database_url(DbKind::App)?,
    };

    let admin0 = load_geojson(&args.admin0_file, "ne_10m_admin_0_countries").await?;
    let quebec_path = args
        .quebec_file
        .clone()
        .unwrap_or_else(|| PathBuf::from(DEFAULT_QUEBEC_PATH));

    let countries = extract_countries(&admin0)?;
    let quebec = load_quebec(&quebec_path)?;
    println!(
        "parsed {} country features + Quebec ({} chars of geometry)",
        countries.len(),
        quebec.geometry_json.len(),
    );

    let pool = db::connect(&database_url).await?;
    db::run_migrations(&pool).await?;
    write_boundaries(&pool, &countries, &quebec).await?;
    pool.close().await;

    println!(
        "admin_boundaries reloaded in {:.1}s",
        started.elapsed().as_secs_f64(),
    );
    Ok(())
}

/// Read one Natural Earth GeoJSON either from a local file or from the
/// official GitHub mirror (`NE_BASE`).
async fn load_geojson(
    file: &Option<PathBuf>,
    name: &str,
) -> Result<JsonValue, Box<dyn std::error::Error>> {
    let text = match file {
        Some(path) => {
            println!("reading {} from {}", name, path.display());
            std::fs::read_to_string(path)?
        }
        None => {
            let url = format!("{NE_BASE}/{name}.geojson");
            println!("downloading {url}");
            reqwest::get(&url).await?.error_for_status()?.text().await?
        }
    };
    Ok(serde_json::from_str(&text)?)
}

/// Case-insensitive property lookup: admin-0 uses upper-case keys
/// (`ISO_A2`) while admin-1 uses lower-case (`iso_3166_2`), and the
/// convention has flipped between Natural Earth releases.
fn prop<'a>(feature: &'a JsonValue, key: &str) -> Option<&'a str> {
    feature.get("properties")?.as_object()?.iter().find_map(|(k, v)| {
        (k.eq_ignore_ascii_case(key)).then(|| v.as_str()).flatten()
    })
}

/// All country features with a usable ISO 3166-1 alpha-2 code. Natural
/// Earth uses `-99` for a few disputed codes; `ISO_A2_EH` ("extended
/// homeland") fills most of them. Features that still have no code are
/// skipped — their POIs will simply count as unresolved.
fn extract_countries(
    admin0: &JsonValue,
) -> Result<Vec<StagedBoundary>, Box<dyn std::error::Error>> {
    let features = admin0["features"]
        .as_array()
        .ok_or("admin-0 GeoJSON has no features array")?;
    let mut out = Vec::new();
    for feature in features {
        let iso = match prop(feature, "ISO_A2") {
            Some("-99") | None => prop(feature, "ISO_A2_EH"),
            other => other,
        };
        let Some(iso) = iso.filter(|c| *c != "-99") else {
            continue;
        };
        out.push(StagedBoundary {
            iso_code: iso.to_string(),
            name: prop(feature, "NAME").unwrap_or(iso).to_string(),
            geometry_json: feature["geometry"].to_string(),
        });
    }
    Ok(out)
}

/// Read the Quebec polygon from a local GeoJSON file — either a bare
/// geometry, a Feature, or a FeatureCollection whose first feature is
/// the polygon.
fn load_quebec(path: &PathBuf) -> Result<StagedBoundary, Box<dyn std::error::Error>> {
    println!("reading Quebec polygon from {}", path.display());
    let doc: JsonValue = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let geometry = match doc["type"].as_str() {
        Some("FeatureCollection") => doc["features"]
            .as_array()
            .and_then(|f| f.first())
            .map(|f| f["geometry"].clone())
            .ok_or("Quebec FeatureCollection has no features")?,
        Some("Feature") => doc["geometry"].clone(),
        _ => doc,
    };
    Ok(StagedBoundary {
        iso_code: "CA-QC".to_string(),
        name: "Québec".to_string(),
        geometry_json: geometry.to_string(),
    })
}

/// Rewrite `admin_boundaries` atomically: stage every feature, then
/// merge features sharing one ISO code (dependencies, disputed slivers)
/// with `ST_Union`, keeping the name of the largest piece.
async fn write_boundaries(
    pool: &PgPool,
    countries: &[StagedBoundary],
    quebec: &StagedBoundary,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        "CREATE TEMP TABLE boundary_staging \
         (iso_code TEXT, name TEXT, geom GEOMETRY) ON COMMIT DROP",
    )
    .execute(&mut *tx)
    .await?;
    for b in countries {
        stage(&mut tx, b).await?;
    }

    sqlx::query("TRUNCATE admin_boundaries").execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO admin_boundaries (level, iso_code, name, geom) \
         SELECT 'country', iso_code, \
                (array_agg(name ORDER BY ST_Area(geom) DESC))[1], \
                ST_Multi(ST_Union(geom)) \
         FROM boundary_staging GROUP BY iso_code",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO admin_boundaries (level, iso_code, name, geom) \
         VALUES ('region', $1, $2, ST_Multi(ST_CollectionExtract( \
                 ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)), 3)))",
    )
    .bind(&quebec.iso_code)
    .bind(&quebec.name)
    .bind(&quebec.geometry_json)
    .execute(&mut *tx)
    .await?;

    tx.commit().await
}

/// Insert one country feature into the staging temp table, validating
/// the geometry server-side.
async fn stage(
    tx: &mut Transaction<'_, Postgres>,
    b: &StagedBoundary,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO boundary_staging (iso_code, name, geom) \
         VALUES ($1, $2, ST_CollectionExtract( \
                 ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)), 3))",
    )
    .bind(&b.iso_code)
    .bind(&b.name)
    .bind(&b.geometry_json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

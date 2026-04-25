//! Entrance Analyser backend — dev-only HTTP server.
//!
//! Binds on `127.0.0.1:3000`, connects to Postgres, applies any pending
//! migrations, and exposes the `/api/bbox/*` routes defined in [`api`].
//! CORS is permissive because the server is only ever run alongside the
//! Vite dev server on the same developer machine.

use std::net::SocketAddr;
use std::path::PathBuf;

use entrance_analyser_backend::{
    api::{self, AppConfig},
    config::{self, DbKind},
    db,
    overpass::OverpassClient,
    poi_config::PoiTagConfig,
    sampler::Sampler,
    storage::PgStore,
};
use tower_http::cors::CorsLayer;

/// Path to the POI tag config when `POI_TAGS_PATH` is unset.
/// Resolved at compile time relative to `CARGO_MANIFEST_DIR`
/// (= `entranceAnalyser/backend`) so the binary finds the YAML
/// regardless of which directory the operator launches it from
/// (`cargo run` from the repo root, from `entranceAnalyser/`, or
/// the absolute `target/release/...` path all work). Override with
/// `POI_TAGS_PATH` for deployments where the YAML lives elsewhere.
const DEFAULT_POI_TAGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../config/poi_tags.yml");

/// Public Overpass endpoint used when `OVERPASS_URL` is unset. The
/// canonical instance, kept rate-friendly by routing through the
/// `interpreter` path; operators with their own mirror should override.
const DEFAULT_OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";

/// `around:` buffer (m) used by `/poi_focus` when
/// `POI_FOCUS_RADIUS_M` is unset. 150 m is roughly a city block in
/// most of the world — wide enough to include the building containing
/// the POI plus a few neighbours, narrow enough to keep the
/// MapLibre source small.
const DEFAULT_POI_FOCUS_RADIUS_M: u32 = 150;

/// URL template used to open the OSM editor at a clicked map
/// location when `OSM_EDITOR_URL` is unset. Defaults to the iD
/// editor on osm.org with the standard `#map=zoom/lat/lon` hash that
/// every osm.org permalink uses. Operators running a self-hosted iD
/// fork (or RapiD, JOSM remote control, etc.) should override this
/// with the appropriate template — `{lat}` / `{lon}` / `{zoom}`
/// placeholders are substituted client-side at click time.
const DEFAULT_OSM_EDITOR_URL: &str = "https://www.openstreetmap.org/edit#map={zoom}/{lat}/{lon}";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    config::load_dotenv();
    let database_url = config::database_url(DbKind::App)?;

    let pool = db::connect(&database_url).await?;
    db::run_migrations(&pool).await?;

    let sampler = Sampler::from_latest(pool.clone()).await?;
    match &sampler {
        Some(s) => println!(
            "sampling from grid_meta: cell_size_km={}, epoch={}, \
             max density = {:.0}/km², built data = {}",
            s.cell_size_km(),
            s.epoch(),
            s.max_density_per_km2(),
            if s.has_built_data() {
                "yes"
            } else {
                "no (uniform/population only)"
            },
        ),
        None => eprintln!(
            "warning: no grid found; /api/bbox/random will return 503 \
             until you run `entrance-analyser-build-grid`",
        ),
    }

    let poi_tags_path = std::env::var("POI_TAGS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_POI_TAGS_PATH));
    let poi_config = PoiTagConfig::load_from_path(&poi_tags_path)?;
    println!(
        "loaded POI tag config from {:?}: {} group(s), {} exception(s)",
        poi_tags_path,
        poi_config.groups.len(),
        poi_config.exceptions.len(),
    );

    let overpass_url =
        std::env::var("OVERPASS_URL").unwrap_or_else(|_| DEFAULT_OVERPASS_URL.to_string());
    println!("Overpass endpoint: {overpass_url}");
    let overpass = OverpassClient::new(overpass_url);

    let poi_focus_radius_m = std::env::var("POI_FOCUS_RADIUS_M")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(DEFAULT_POI_FOCUS_RADIUS_M);
    println!("POI focus radius: {poi_focus_radius_m} m");

    let osm_editor_url =
        std::env::var("OSM_EDITOR_URL").unwrap_or_else(|_| DEFAULT_OSM_EDITOR_URL.to_string());
    println!("OSM editor URL template: {osm_editor_url}");

    let app_config = AppConfig {
        osm_editor_url,
        poi_focus_radius_m,
    };
    let state = api::AppState::new(
        PgStore::new(pool),
        sampler,
        poi_config,
        overpass,
        app_config,
    );
    let app = api::router(state).layer(CorsLayer::permissive());

    let addr: SocketAddr = "127.0.0.1:3000".parse().expect("valid socket addr");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("entrance-analyser-backend listening on http://{addr}");
    println!("kept bboxes and analyses are persisted to {database_url}");

    axum::serve(listener, app).await?;
    Ok(())
}

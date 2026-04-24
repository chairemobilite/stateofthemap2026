//! Entrance Analyser backend — dev-only HTTP server.
//!
//! Binds on `127.0.0.1:3000`, connects to Postgres, applies any pending
//! migrations, and exposes the `/api/bbox/*` routes defined in [`api`].
//! CORS is permissive because the server is only ever run alongside the
//! Vite dev server on the same developer machine.

use std::net::SocketAddr;

use entrance_analyser_backend::{
    api,
    config::{self, DbKind},
    db,
    sampler::Sampler,
    storage::PgStore,
};
use tower_http::cors::CorsLayer;

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

    let state = api::AppState::new(PgStore::new(pool), sampler);
    let app = api::router(state).layer(CorsLayer::permissive());

    let addr: SocketAddr = "127.0.0.1:3000".parse().expect("valid socket addr");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("entrance-analyser-backend listening on http://{addr}");
    println!("kept bboxes and analyses are persisted to {database_url}");

    axum::serve(listener, app).await?;
    Ok(())
}

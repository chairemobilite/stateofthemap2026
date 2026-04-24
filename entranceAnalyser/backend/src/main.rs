//! Entrance Analyser backend — dev-only HTTP server.
//!
//! Binds on `127.0.0.1:3000` and exposes the `/api/bbox/*` routes defined
//! in [`api`]. CORS is permissive because the server is only ever run
//! alongside the Vite dev server on the same developer machine.

use std::net::SocketAddr;
use std::path::PathBuf;

use entrance_analyser_backend::{api, sampler::Sampler, storage};
use tower_http::cors::CorsLayer;

/// Override the kept-bboxes file location. Defaults to `data/kept_bboxes.json`
/// relative to the current working directory.
const DATA_PATH_ENV: &str = "ENTRANCE_ANALYSER_DATA";

/// Override the GHS-POP grid file location. Defaults to
/// `data/world_grid_2020_10km.bin`. If the file does not exist the server
/// still starts; `/api/bbox/random` then returns 503 with a hint.
const GRID_PATH_ENV: &str = "ENTRANCE_ANALYSER_GRID";

#[tokio::main]
async fn main() {
    let data_path = std::env::var(DATA_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/kept_bboxes.json"));
    let grid_path = std::env::var(GRID_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/world_grid_2020_10km.bin"));

    let sampler = match Sampler::from_path(&grid_path) {
        Ok(s) => {
            println!(
                "loaded {} cells of {} × {} km from {} (max density: {:.0}/km²)",
                s.cell_count(), s.cell_size_km(), s.cell_size_km(),
                grid_path.display(), s.max_density_per_km2(),
            );
            Some(s)
        }
        Err(err) => {
            eprintln!(
                "warning: no usable grid at {} ({err}); /api/bbox/random will return 503 \
                 until you run `entrance-analyser-build-grid`",
                grid_path.display(),
            );
            None
        }
    };

    let state = api::AppState::new(storage::JsonStore::new(&data_path), sampler);
    let app = api::router(state).layer(CorsLayer::permissive());

    let addr: SocketAddr = "127.0.0.1:3000".parse().expect("valid socket addr");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("port 3000 is free");

    println!("entrance-analyser-backend listening on http://{addr}");
    println!("kept bboxes will be written to {}", data_path.display());

    axum::serve(listener, app).await.expect("server error");
}

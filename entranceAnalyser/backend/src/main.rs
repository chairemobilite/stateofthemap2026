//! Entrance Analyser backend — dev-only HTTP server.
//!
//! Binds on `127.0.0.1:3000` and exposes the `/api/bbox/*` routes defined
//! in [`api`]. CORS is permissive because the server is only ever run
//! alongside the Vite dev server on the same developer machine.

use std::net::SocketAddr;
use std::path::PathBuf;

use tower_http::cors::CorsLayer;

mod api;
mod bbox;
mod storage;

/// Override the kept-bboxes file location. Defaults to `data/kept_bboxes.json`
/// relative to the current working directory.
const DATA_PATH_ENV: &str = "ENTRANCE_ANALYSER_DATA";

#[tokio::main]
async fn main() {
    let data_path = std::env::var(DATA_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/kept_bboxes.json"));

    let state = api::AppState::new(storage::JsonStore::new(&data_path));
    let app = api::router(state).layer(CorsLayer::permissive());

    let addr: SocketAddr = "127.0.0.1:3000".parse().expect("valid socket addr");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("port 3000 is free");

    println!("entrance-analyser-backend listening on http://{addr}");
    println!("kept bboxes will be written to {}", data_path.display());

    axum::serve(listener, app).await.expect("server error");
}

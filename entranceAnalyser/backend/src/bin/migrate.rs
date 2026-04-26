//! Apply pending SQL migrations to the application database (`PG_DATABASE`).
//!
//! Reads the same `.env` / `PG_*` variables as the HTTP server (`config::load_dotenv`
//! + `database_url(App)`). Idempotent: re-running applies only migrations
//! not yet recorded in `_sqlx_migrations`.
//!
//! ```sh
//! cd entranceAnalyser
//! cargo run --bin entrance-analyser-migrate
//! ```

use entrance_analyser_backend::config::{self, DbKind};
use entrance_analyser_backend::db;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    config::load_dotenv();
    let database_url = config::database_url(DbKind::App)?;
    let pool = db::connect(&database_url).await?;
    db::run_migrations(&pool).await?;
    let db_name = std::env::var("PG_DATABASE").unwrap_or_else(|_| "(PG_DATABASE unset)".to_string());
    println!("migrations applied for database {db_name}");
    Ok(())
}

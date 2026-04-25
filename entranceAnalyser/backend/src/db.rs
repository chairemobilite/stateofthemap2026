//! Postgres connection + migration helpers.
//!
//! All the SQL lives in `migrations/` and is embedded into the binary at
//! compile time by the `sqlx::migrate!` macro, so the server brings the
//! schema up to date on every startup without any extra tooling.

use sqlx::migrate::{MigrateError, Migrator};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::time::Duration;

/// Embedded migrator. Exposed so integration tests can apply the same
/// migrations to ephemeral databases.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Open a pool with sensible defaults for a dev-only backend.
pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(url)
        .await
}

/// Apply every pending migration. Idempotent.
pub async fn run_migrations(pool: &PgPool) -> Result<(), MigrateError> {
    MIGRATOR.run(pool).await
}

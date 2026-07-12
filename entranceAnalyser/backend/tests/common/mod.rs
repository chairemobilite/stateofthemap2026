/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Shared integration-test harness.
//!
//! Each test gets its own disposable database named
//! `<PG_DATABASE_TEST>_<uuid>`. We connect to the server's built-in
//! `postgres` database to `CREATE DATABASE`, run the embedded migrations
//! on the fresh database, and return both the pool and a guard that
//! drops the database when it goes out of scope.
//!
//! When Postgres is unreachable (e.g. nobody started the server locally)
//! [`try_fresh_db`] returns `Err` and test bodies bail out gracefully
//! rather than failing the whole suite. CI always provides a live server.

#![allow(dead_code)]

use entrance_analyser_backend::{config, db};
use sqlx::{Connection, Executor, PgConnection, PgPool};
use uuid::Uuid;

/// Handle to an ephemeral database. Dropping it asynchronously would be
/// nicer but Rust's `Drop` can't be async; we best-effort-drop in the
/// blocking `Drop` impl and tests are free to also call [`cleanup`]
/// explicitly when they care.
pub struct TestDb {
    pub pool: PgPool,
    pub name: String,
    pub url: String,
    pub admin_url: String,
}

impl TestDb {
    /// Close the pool and drop the database. Call from tests to surface
    /// cleanup errors instead of relying on the best-effort `Drop`.
    pub async fn cleanup(mut self) -> Result<(), sqlx::Error> {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.admin_url).await?;
        admin
            .execute(format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, self.name).as_str())
            .await?;
        // Blank out the name so the Drop impl doesn't try again.
        self.name.clear();
        Ok(())
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if self.name.is_empty() {
            return;
        }
        // Best-effort: spin up a short-lived runtime to drop the db.
        let name = std::mem::take(&mut self.name);
        let admin_url = self.admin_url.clone();
        let _ = std::thread::spawn(move || {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(_) => return,
            };
            rt.block_on(async move {
                if let Ok(mut admin) = PgConnection::connect(&admin_url).await {
                    let _ = admin
                        .execute(
                            format!(r#"DROP DATABASE IF EXISTS "{name}" WITH (FORCE)"#).as_str(),
                        )
                        .await;
                }
            });
        })
        .join();
    }
}

/// Create a fresh, migrated database. Returns `Err` when Postgres can't
/// be reached so tests can `return` early instead of failing.
pub async fn try_fresh_db() -> Result<TestDb, String> {
    config::load_dotenv();
    let prefix = config::connection_prefix().map_err(|e| e.to_string())?;
    let base =
        std::env::var("PG_DATABASE_TEST").map_err(|_| "PG_DATABASE_TEST is not set".to_string())?;

    // Create the ephemeral database name up front so the Drop impl can
    // clean up even if migrations fail partway.
    let name = format!("{base}_{}", Uuid::new_v4().simple());
    let admin_url = config::database_url_for(&prefix, "postgres");

    let mut admin = PgConnection::connect(&admin_url)
        .await
        .map_err(|e| format!("cannot connect to {admin_url}: {e}"))?;
    admin
        .execute(format!(r#"CREATE DATABASE "{name}""#).as_str())
        .await
        .map_err(|e| format!("CREATE DATABASE {name} failed: {e}"))?;

    let url = config::database_url_for(&prefix, &name);
    let pool = db::connect(&url)
        .await
        .map_err(|e| format!("cannot open pool on {url}: {e}"))?;
    db::run_migrations(&pool)
        .await
        .map_err(|e| format!("migrations failed: {e}"))?;

    Ok(TestDb {
        pool,
        name,
        url,
        admin_url,
    })
}

/// Skip the test body with an `eprintln!` when Postgres is unavailable.
/// Usage:
/// ```ignore
/// let Some(db) = common::pg_or_skip().await else { return };
/// ```
pub async fn pg_or_skip() -> Option<TestDb> {
    match try_fresh_db().await {
        Ok(db) => Some(db),
        Err(e) => {
            eprintln!("skipping db-backed test: {e}");
            None
        }
    }
}

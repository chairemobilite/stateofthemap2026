/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Environment-driven configuration helpers.
//!
//! The workspace stores Postgres credentials in `.env` (and `.env.example`)
//! as three separate variables so the same prefix can be combined with
//! either the dev or the test database name:
//!
//! ```text
//! PG_CONNECTION_STRING_PREFIX = postgres://postgres:@localhost:5432/
//! PG_DATABASE                 = entrance_analyser
//! PG_DATABASE_TEST            = entrance_analyser_test
//! ```
//!
//! Splitting prefix and database name makes it trivial for tests to carve
//! out a fresh database on the same server without duplicating the rest of
//! the URL in a second env variable.

use std::env;

/// Which database we want a URL for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbKind {
    /// The long-lived application database (`PG_DATABASE`).
    App,
    /// The base name of the test database (`PG_DATABASE_TEST`). Integration
    /// tests typically append a unique suffix to this to get an isolated
    /// database per test run.
    Test,
}

const PREFIX: &str = "PG_CONNECTION_STRING_PREFIX";
const APP_DB: &str = "PG_DATABASE";
const TEST_DB: &str = "PG_DATABASE_TEST";

/// Loads `.env` from the workspace (best effort) so callers can just read
/// environment variables. Safe to call multiple times; `dotenvy` ignores a
/// missing file.
pub fn load_dotenv() {
    let _ = dotenvy::dotenv();
}

/// Resolve the full `postgres://.../<db>` URL for the requested database.
///
/// # Errors
/// Returns a human-readable message if any of the expected env variables
/// are missing so the caller can surface a precise startup error.
pub fn database_url(kind: DbKind) -> Result<String, String> {
    let prefix = env::var(PREFIX).map_err(|_| format!("{PREFIX} is not set"))?;
    let name_var = match kind {
        DbKind::App => APP_DB,
        DbKind::Test => TEST_DB,
    };
    let name = env::var(name_var).map_err(|_| format!("{name_var} is not set"))?;
    Ok(database_url_for(&prefix, &name))
}

/// Combine a prefix and a database name into a full URL. Exposed so
/// integration tests can build URLs for per-test databases from the same
/// prefix without going through the env again.
pub fn database_url_for(prefix: &str, database: &str) -> String {
    // The prefix is documented to already end with a `/`, but be forgiving
    // if the user pasted a bare host.
    if prefix.ends_with('/') {
        format!("{prefix}{database}")
    } else {
        format!("{prefix}/{database}")
    }
}

/// Resolve the prefix alone, useful for connecting to the server's
/// built-in `postgres` administrative database to create/drop test dbs.
pub fn connection_prefix() -> Result<String, String> {
    env::var(PREFIX).map_err(|_| format!("{PREFIX} is not set"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case("postgres://u:p@h:5432/", "mydb", "postgres://u:p@h:5432/mydb")]
    #[case("postgres://u:p@h:5432", "mydb", "postgres://u:p@h:5432/mydb")]
    fn url_joins_prefix_and_database(
        #[case] prefix: &str,
        #[case] database: &str,
        #[case] expected: &str,
    ) {
        assert_eq!(database_url_for(prefix, database), expected);
    }
}

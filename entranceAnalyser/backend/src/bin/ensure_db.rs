//! Idempotently create the application and test databases configured in
//! `.env`. Lets developers without `psql` / `createdb` on their `PATH`
//! bootstrap the project with a single Cargo command:
//!
//! ```sh
//! cargo run --bin entrance-analyser-ensure-db
//! ```
//!
//! We connect to the server's built-in `postgres` database with the
//! credentials in `PG_CONNECTION_STRING_PREFIX`, check `pg_database` for
//! each target, and `CREATE DATABASE` the ones that are missing. Running
//! the command twice is a no-op.

use entrance_analyser_backend::config;
use sqlx::{Connection, Executor, PgConnection, Row};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    config::load_dotenv();
    let prefix = config::connection_prefix()?;

    let databases = [
        ("PG_DATABASE", std::env::var("PG_DATABASE")?),
        ("PG_DATABASE_TEST", std::env::var("PG_DATABASE_TEST")?),
    ];

    let admin_url = config::database_url_for(&prefix, "postgres");
    let mut admin = PgConnection::connect(&admin_url).await.map_err(|e| {
        format!("cannot connect to {admin_url} (check PG_CONNECTION_STRING_PREFIX): {e}")
    })?;

    for (var, name) in databases {
        if database_exists(&mut admin, &name).await? {
            println!("{var}={name} already exists, skipping");
            continue;
        }
        // Database names can't be passed as bind parameters, and we don't
        // want to swallow escaping bugs silently: reject anything that
        // isn't a plain identifier.
        assert_safe_identifier(&name)?;
        admin
            .execute(format!(r#"CREATE DATABASE "{name}""#).as_str())
            .await
            .map_err(|e| format!("CREATE DATABASE {name} failed: {e}"))?;
        println!("{var}={name} created");
    }

    Ok(())
}

async fn database_exists(conn: &mut PgConnection, name: &str) -> Result<bool, sqlx::Error> {
    let row = sqlx::query("SELECT 1 AS found FROM pg_database WHERE datname = $1")
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.map(|r| r.get::<i32, _>("found") == 1).unwrap_or(false))
}

fn assert_safe_identifier(name: &str) -> Result<(), String> {
    let ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "database name {name:?} must match [A-Za-z0-9_]+; refusing to interpolate it"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::assert_safe_identifier;
    use rstest::rstest;

    #[rstest]
    #[case("entrance_analyser")]
    #[case("Entrance_Analyser_42")]
    fn accepts_plain_identifiers(#[case] name: &str) {
        assert!(assert_safe_identifier(name).is_ok());
    }

    #[rstest]
    #[case("")]
    #[case("drop; --")]
    #[case("foo bar")]
    #[case("foo\"bar")]
    fn rejects_suspicious_names(#[case] name: &str) {
        assert!(assert_safe_identifier(name).is_err());
    }
}

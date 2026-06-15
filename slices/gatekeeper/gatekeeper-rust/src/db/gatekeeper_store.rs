//! The `GatekeeperStore` handle — wraps the shared connection and applies the
//! gatekeeper schema migrations onto it. Per-table query methods are added as
//! inherent `impl GatekeeperStore` blocks in the sibling `db/*` modules.

use anyhow::Context;
use persistence_rust::Connection;

#[derive(Clone)]
pub struct GatekeeperStore {
    conn: Connection,
}

impl GatekeeperStore {
    /// Wrap the shared `conn` and apply pending gatekeeper migrations onto it.
    /// The connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the gatekeeper migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply gatekeeper migrations")?;
        }
        Ok(Self { conn })
    }

    /// Open a private in-memory shared connection and wrap it — for tests.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(Connection::open_in_memory().context("failed to open in-memory sqlite")?)
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}

/// Migration namespace for the gatekeeper tables in the shared database.
const NAMESPACE: &str = "gatekeeper";

/// Apply pending gatekeeper migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `gatekeeper` namespace.
fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. New migrations land as a sibling `.sql` file under
/// `src/migrations/` plus one new `include_str!` line below.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_refresh_tokens.sql"),
    include_str!("../migrations/003_refresh_family_authorization_code.sql"),
    include_str!("../migrations/004_unique_authorization_code_request_id.sql"),
    include_str!("../migrations/005_unique_pending_user_code.sql"),
    include_str!("../migrations/006_unique_grant_client_redirect.sql"),
    include_str!("../migrations/007_client_allowed_grant_types.sql"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE namespace = ?1",
                [NAMESPACE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn migrate_creates_expected_tables() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in [
            "authorization_codes",
            "authorization_requests",
            "clients",
            "grants",
            "refresh_token_families",
            "refresh_tokens",
            "signing_keys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }
}

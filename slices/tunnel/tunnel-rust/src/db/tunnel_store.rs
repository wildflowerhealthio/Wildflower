//! The `TunnelStore` handle — wraps the *shared* sqlite connection (opened
//! once by the host and passed into each slice) and applies the tunnel schema
//! migrations onto it. Per-table query methods are added as inherent
//! `impl TunnelStore` blocks in the sibling `db/*` modules. Mirrors
//! `gatekeeper-rust`'s `GatekeeperStore`.

use anyhow::Context;
use persistence_rust::Connection;

#[derive(Clone)]
pub struct TunnelStore {
    conn: Connection,
}

impl TunnelStore {
    /// Wrap the shared `conn` and apply pending tunnel migrations onto it. The
    /// connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the tunnel migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply tunnel migrations")?;
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

/// Migration namespace for the tunnel tables in the shared database.
const NAMESPACE: &str = "tunnel";

/// Apply pending tunnel migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `tunnel` namespace, so
/// they coexist with other slices in one shared database.
fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. New migrations land as a sibling `.sql` file under
/// `src/migrations/` plus one new `include_str!` line below.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/001_initial_schema.sql")];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent_and_creates_the_settings_table() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tunnel_settings'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(exists, "tunnel_settings table must exist after migrate");
    }
}

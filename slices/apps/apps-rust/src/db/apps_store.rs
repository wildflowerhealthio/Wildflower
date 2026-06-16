//! The `AppsStore` handle — wraps the *shared* sqlite connection (opened
//! once by the host and passed into each slice) and applies the apps schema
//! migrations onto it. Per-table query methods are added as inherent
//! `impl AppsStore` blocks in the sibling `db/*` modules. Mirrors
//! `tunnel-rust`'s `TunnelStore`.

use anyhow::Context;
use persistence_rust::Connection;

#[derive(Clone)]
pub struct AppsStore {
    conn: Connection,
}

impl AppsStore {
    /// Wrap the shared `conn` and apply pending apps migrations onto it. The
    /// connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the apps migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply apps migrations")?;
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

/// Migration namespace for the apps tables in the shared database.
const NAMESPACE: &str = "apps";

/// Apply pending apps migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `apps` namespace, so
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
    fn migrate_is_idempotent_and_creates_the_apps_table() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='apps'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(exists, "apps table must exist after migrate");
    }

    /// Every bundled-registry id must be seeded by the initial migration so
    /// flipping `enabled` on a bundled app is an UPDATE (not an INSERT that
    /// has to first decide what `kind` to write).
    #[test]
    fn migration_seeds_every_bundled_registry_id() {
        use crate::domain::BUNDLED_APPS;
        let store = AppsStore::open_in_memory().unwrap();
        let guard = store.conn().lock();
        for app in BUNDLED_APPS {
            let kind: String = guard
                .query_row("SELECT kind FROM apps WHERE id = ?1", [app.id], |row| {
                    row.get(0)
                })
                .unwrap_or_else(|_| panic!("missing seed for {}", app.id));
            let expected = match app.kind {
                crate::domain::BundledKind::Bundled => "bundled",
                crate::domain::BundledKind::Action => "action",
            };
            assert_eq!(kind, expected, "seed kind for {}", app.id);
        }
    }
}

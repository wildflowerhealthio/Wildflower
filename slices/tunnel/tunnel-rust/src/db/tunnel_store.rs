//! The `SqliteTunnelStore` adapter — the `SQLite` implementation of the
//! [`TunnelStore`](crate::domain::TunnelStore) port. Holds the app-wide r2d2
//! pool of Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the
//! shared database file, applies the embedded tunnel migrations once on
//! construction, and implements the port by delegating to the per-concern query
//! bodies (`tunnel_settings`, `seed_tunnel_settings`). Mirrors
//! `collector-rust`'s `RemotesStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use persistence_rust::DieselPool;

use crate::db::{seed_tunnel_settings, tunnel_settings};
use crate::domain::{
    RelaySettings, SettingsSeed, SettingsUpdateOutcome, TunnelError, TunnelSettings, TunnelStore,
};

/// The tunnel migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteTunnelStore::new`]; diesel records
/// applied versions in its own `__diesel_schema_migrations` table, disjoint from
/// the namespaced `schema_migrations` the other (rusqlite) slices use, so the
/// two bookkeepers coexist in the shared database with no collision. Migration
/// `0001` uses idempotent DDL so it's a no-op on a database whose
/// `tunnel_settings` table predates this diesel migration (see the migration's
/// `up.sql`).
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`TunnelStore`] port. Cheap to clone (the pool
/// is an `Arc` inside), so it drops straight into the axum state.
#[derive(Clone)]
pub struct SqliteTunnelStore {
    // The app-wide r2d2 pool onto the shared database file, built and owned by
    // the host (`persistence_rust::open_pool`). Diesel's connection API is
    // `&mut`, so each query checks a connection out of the pool rather than
    // sharing one behind a mutex; the pool (an `Arc` inside) makes the store
    // cheap to clone into the axum state. These are additional openers onto the
    // same file the host's rusqlite `persistence-rust::Connection` serves the
    // other slices from — SQLite permits multiple connections per file; the
    // pool's `busy_timeout` pragma rides out the brief write locks any
    // connection takes (see `persistence_rust::open_pool`).
    pool: DieselPool,
}

impl SqliteTunnelStore {
    /// Wrap the host-owned connection `pool` and apply pending tunnel migrations
    /// once, on a single checked-out connection. The host builds the app-wide
    /// pool (via `persistence_rust::open_pool`) on the same file its rusqlite
    /// connection opens for the other slices; both coexist (see the `pool`
    /// field).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run tunnel migrations")?;
        conn.run_pending_migrations(MIGRATIONS)
            .map_err(|e| anyhow::anyhow!("failed to apply tunnel migrations: {e}"))?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call is
    /// an independent, freshly-migrated database. Uses
    /// `persistence_rust::open_in_memory_pool`, whose shared-cache URI keeps the
    /// pooled connections on one in-memory database (a naive `:memory:` pool
    /// gives each connection its own empty db).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(persistence_rust::open_in_memory_pool()?)
    }

    /// The pool the sibling query modules check connections out of.
    fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The `SQLite` implementation of the port: each method is a thin delegation to
/// the per-concern query body, handing it a checked-out connection from the
/// pool. The bodies live in `tunnel_settings` / `seed_tunnel_settings` so this
/// file stays the migration + pool handle, and the query SQL stays next to the
/// row types it maps.
impl TunnelStore for SqliteTunnelStore {
    fn get_settings(&self) -> Result<TunnelSettings, TunnelError> {
        tunnel_settings::get_settings(self.pool())
    }

    fn update_basic_settings(
        &self,
        expected_revision: i64,
        public_host: Option<&str>,
        requested_running: bool,
    ) -> Result<SettingsUpdateOutcome, TunnelError> {
        tunnel_settings::update_basic_settings(
            self.pool(),
            expected_revision,
            public_host,
            requested_running,
        )
    }

    fn update_all_settings(
        &self,
        expected_revision: i64,
        public_host: Option<&str>,
        requested_running: bool,
        relay: &RelaySettings,
    ) -> Result<SettingsUpdateOutcome, TunnelError> {
        tunnel_settings::update_all_settings(
            self.pool(),
            expected_revision,
            public_host,
            requested_running,
            relay,
        )
    }

    fn seed_if_absent(&self, seed: &SettingsSeed) -> Result<(), TunnelError> {
        seed_tunnel_settings::seed_if_absent(self.pool(), seed)
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::db::schema::tunnel_settings;

    /// Running the migrations twice is a no-op the second time (diesel skips
    /// already-applied versions), the table exists, and its singleton row is
    /// seeded exactly once — so opening an existing database never re-seeds or
    /// errors.
    #[test]
    fn migrations_are_idempotent_and_seed_the_singleton_row_once() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        conn.run_pending_migrations(MIGRATIONS).unwrap();
        conn.run_pending_migrations(MIGRATIONS).unwrap();
        let row_count: i64 = tunnel_settings::table
            .count()
            .get_result(&mut conn)
            .expect("tunnel_settings must exist after migrate");
        assert_eq!(row_count, 1, "exactly the one seeded singleton row");
    }

    /// Applying `0001` against a database that already carries the
    /// `tunnel_settings` table (the pre-diesel install path) is a no-op rather
    /// than a failure — the idempotent `IF NOT EXISTS` / `INSERT OR IGNORE` DDL —
    /// and it neither duplicates nor overwrites the existing singleton row.
    #[test]
    fn migration_is_a_no_op_against_a_preexisting_table() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        // Simulate the pre-diesel install: the table + row already exist, with a
        // non-default revision so an accidental overwrite would be visible.
        diesel::sql_query(
            "CREATE TABLE tunnel_settings (\
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, public_host TEXT, \
                requested_running INTEGER NOT NULL DEFAULT 0, relay_remote_addr TEXT, \
                relay_token TEXT, relay_public_key TEXT, service_name TEXT) STRICT;",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query("INSERT INTO tunnel_settings (id, revision) VALUES ('tunnel', 7)")
            .execute(&mut conn)
            .unwrap();

        conn.run_pending_migrations(MIGRATIONS).unwrap();

        let row_count: i64 = tunnel_settings::table
            .count()
            .get_result(&mut conn)
            .unwrap();
        assert_eq!(row_count, 1, "the migration did not duplicate the row");
        let revision: i64 = tunnel_settings::table
            .select(tunnel_settings::revision)
            .first(&mut conn)
            .unwrap();
        assert_eq!(revision, 7, "the migration did not overwrite the row");
    }
}

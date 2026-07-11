//! The `GatekeeperStore` handle — holds the app-wide r2d2 pool of Diesel
//! `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared
//! database file and applies the embedded gatekeeper migrations once on
//! construction. Per-table query methods are added as inherent
//! `impl GatekeeperStore` blocks in the sibling `db/*` modules; each one
//! checks a connection out of the pool.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use persistence_rust::DieselPool;

use crate::domain::error::GatekeeperError;

/// The gatekeeper migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`GatekeeperStore::new`]; diesel records
/// applied versions in its own `__diesel_schema_migrations` table, disjoint
/// from persistence-rust's namespaced `schema_migrations`, so the two
/// migration bookkeepers coexist in the shared database. Migration `0001`
/// deliberately DROPs the tables the retired rusqlite migrations managed
/// (destructive rebaseline — see its header) and `0002` seeds the SMART
/// sample-app clients.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

#[derive(Clone)]
pub struct GatekeeperStore {
    // The app-wide r2d2 pool onto the shared database file, built and owned by
    // the host (`persistence_rust::open_pool`) — the same pool collector's
    // RemotesStore rides. Diesel's connection API is `&mut`, so each call
    // checks a connection out of the pool rather than sharing one behind a
    // mutex; the pool (an `Arc` inside) makes the store cheap to clone into
    // the axum state. These are additional openers onto the same file the
    // host's rusqlite `persistence-rust::Connection` serves the remaining
    // rusqlite slices from — SQLite permits multiple connections per file; the
    // pool's `busy_timeout` pragma rides out the brief write locks any
    // connection takes (see `persistence_rust::open_pool`).
    pool: DieselPool,
}

/// A connection checked out of the store's pool — the type every per-table
/// query method works against.
pub(crate) type PooledSqliteConnection = diesel::r2d2::PooledConnection<
    diesel::r2d2::ConnectionManager<diesel::sqlite::SqliteConnection>,
>;

impl GatekeeperStore {
    /// Wrap the host-owned connection `pool` and apply pending gatekeeper
    /// migrations once, on a single checked-out connection. The host builds
    /// the app-wide pool (via `persistence_rust::open_pool`) on the same file
    /// its rusqlite connection opens for the other slices; both coexist (see
    /// the `pool` field).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run gatekeeper migrations")?;
        conn.run_pending_migrations(MIGRATIONS)
            .map_err(|e| anyhow::anyhow!("failed to apply gatekeeper migrations: {e}"))?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call
    /// is an independent, freshly-migrated database. Uses
    /// `persistence_rust::open_in_memory_pool`, whose shared-cache URI keeps
    /// the pooled connections on one in-memory database (a naive `:memory:`
    /// pool gives each connection its own empty db).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(persistence_rust::open_in_memory_pool()?)
    }

    /// Check a connection out of the pool, mapping a checkout failure to the
    /// domain's opaque [`GatekeeperError::Backend`] — the shared first step of
    /// every query method in the sibling `db/*` modules.
    pub(crate) fn conn(&self) -> Result<PooledSqliteConnection, GatekeeperError> {
        self.pool
            .get()
            .map_err(|e| GatekeeperError::backend("failed to check out a connection", e))
    }
}

#[cfg(test)]
mod tests {
    use diesel::connection::SimpleConnection;
    use diesel::prelude::*;
    use diesel::sqlite::SqliteConnection;
    use diesel_migrations::MigrationHarness;

    use super::MIGRATIONS;
    use crate::db::GatekeeperStore;

    #[derive(QueryableByName)]
    struct Name {
        #[diesel(sql_type = diesel::sql_types::Text)]
        name: String,
    }

    /// Running the migrations twice is a no-op the second time (diesel skips
    /// already-applied versions) and every expected table — plus the `grants`
    /// view — exists afterwards, so opening an existing database never
    /// re-drops or errors.
    #[test]
    fn migrations_are_idempotent_and_create_the_schema() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        conn.run_pending_migrations(MIGRATIONS).expect("first run");
        conn.run_pending_migrations(MIGRATIONS).expect("second run");
        let names: Vec<String> = diesel::sql_query(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
        )
        .load::<Name>(&mut conn)
        .expect("list tables")
        .into_iter()
        .map(|n| n.name)
        .collect();
        for expected in [
            "authorization_code_grants",
            "authorization_codes",
            "authorization_requests",
            "clients",
            "device_grants",
            "grants",
            "refresh_token_families",
            "refresh_tokens",
            "signing_keys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    /// Migration `0001` is a destructive rebaseline: applied over a database
    /// carrying the retired rusqlite-migrated tables (simulated here by
    /// pre-creating an old-shape `grants` parent + child with a row in it),
    /// it drops them and recreates the final shape — no copy, no error.
    #[test]
    fn migration_rebaselines_over_the_old_rusqlite_tables() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        conn.batch_execute(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE grants (
                 id TEXT PRIMARY KEY NOT NULL,
                 client_id TEXT NOT NULL,
                 scopes TEXT NOT NULL,
                 granted_at TEXT NOT NULL,
                 last_used_at TEXT,
                 patient TEXT,
                 grant_type TEXT NOT NULL
             );
             CREATE TABLE authorization_code_grants (
                 id TEXT PRIMARY KEY NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
                 client_id TEXT NOT NULL,
                 redirect_uri TEXT NOT NULL
             );
             INSERT INTO grants VALUES
                 ('g1', 'c1', '[]', '2024-01-01 00:00:00+00:00', NULL, NULL,
                  'authorization_code');
             INSERT INTO authorization_code_grants VALUES
                 ('g1', 'c1', 'https://example.com/cb');",
        )
        .expect("simulate the old schema");

        conn.run_pending_migrations(MIGRATIONS).expect("rebaseline");

        // The old parent's row is gone (destructive) and `grants` is now the
        // UNION ALL view over the two rebuilt concrete tables.
        let grants: Vec<Name> = diesel::sql_query("SELECT id AS name FROM grants")
            .load(&mut conn)
            .expect("grants view is queryable");
        assert!(grants.is_empty(), "the rebaseline copies no data");
        let kind: Vec<Name> =
            diesel::sql_query("SELECT type AS name FROM sqlite_master WHERE name = 'grants'")
                .load(&mut conn)
                .expect("sqlite_master");
        assert_eq!(kind.len(), 1);
        assert_eq!(kind[0].name, "view");
    }

    /// The in-memory constructor produces an independent, migrated store per
    /// call — the isolation every store test relies on.
    #[test]
    fn open_in_memory_stores_are_independent() {
        let a = GatekeeperStore::open_in_memory().expect("store a");
        let b = GatekeeperStore::open_in_memory().expect("store b");
        let key = crate::domain::signing_key::SigningKey::generate().expect("generate key");
        a.insert_signing_key(&key).expect("insert into a");
        assert_eq!(a.all_signing_keys().expect("read a").len(), 1);
        assert_eq!(
            b.all_signing_keys().expect("read b").len(),
            0,
            "store b must not see store a's key",
        );
    }
}

//! The `SqliteTunnelStore` adapter — the `SQLite` implementation of the
//! [`TunnelStore`] port. Opens the relay's own
//! database file, `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db`, as an r2d2 pool
//! of Diesel `SqliteConnection`s (`persistence_rust::DieselPool`), applies
//! the embedded relay migrations once on construction, and implements the
//! port by delegating to the query bodies in `tunnels`. Mirrors
//! `tunnel-rust`'s `SqliteTunnelStore`.
//!
//! Tokens are stored in plain text, since rathole and the HMAC check both
//! need them, so the file is created readable by the owner only, like the
//! rendered rathole TOML. Every call blocks on SQLite; the registry runs
//! them off the async runtime.

use std::path::Path;

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::db::tunnels;
use crate::domain::{StoredTunnel, TunnelError, TunnelStore};

/// The relay's migration namespace. Applied versions are bookkept
/// per-namespace by [`persistence_rust::run_diesel_migrations`], the same
/// runner the slices use, though the relay's database holds no other
/// namespace.
const MIGRATION_NAMESPACE: &str = "wildflower_relay";

/// The relay migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteTunnelStore::new`] via
/// [`persistence_rust::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`].
/// Append-only: never reorder or rewrite a shipped migration.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`TunnelStore`] port. Cheap to clone (the
/// pool is an `Arc` inside), so a clone moves onto a blocking thread for
/// each call.
#[derive(Clone)]
pub struct SqliteTunnelStore {
    // An r2d2 pool onto `tunnels.db`. Diesel's connection API is `&mut`, so
    // each query checks a connection out rather than sharing one behind a
    // mutex.
    pool: DieselPool,
}

impl std::fmt::Debug for SqliteTunnelStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteTunnelStore").finish_non_exhaustive()
    }
}

impl SqliteTunnelStore {
    /// The store's file name in the state directory.
    pub const FILE_NAME: &'static str = "tunnels.db";

    /// Open (or create) the store at `path`, readable by the owner only, and
    /// apply its migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the file cannot be created or opened, or a
    /// migration fails.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        create_private(path).with_context(|| format!("creating {}", path.display()))?;
        Self::new(persistence_rust::open_pool(path)?)
            .with_context(|| format!("migrating {}", path.display()))
    }

    /// Wrap `pool` and apply pending relay migrations once, on a single
    /// checked-out connection.
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run relay migrations")?;
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .context("failed to apply relay migrations")?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call
    /// is an independent, freshly-migrated database (see
    /// `persistence_rust::open_in_memory_pool`).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(persistence_rust::open_in_memory_pool()?)
    }

    /// Check out a connection from the pool.
    fn connection(&self) -> Result<PooledDieselConnection, TunnelError> {
        self.pool
            .get()
            .map_err(|e| TunnelError::infrastructure("failed to check out a connection", e))
    }
}

/// The `SQLite` implementation of the port: each method is a thin delegation
/// to the query body in `tunnels`, handing it a checked-out connection.
impl TunnelStore for SqliteTunnelStore {
    fn list_tunnels(&self) -> Result<Vec<StoredTunnel>, TunnelError> {
        tunnels::list_tunnels(&mut self.connection()?)
    }

    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<(), TunnelError> {
        tunnels::insert_tunnel(&mut self.connection()?, stored)
    }

    fn delete_tunnel(&self, name: &str) -> Result<bool, TunnelError> {
        tunnels::delete_tunnel(&mut self.connection()?, name)
    }
}

/// Create `path` if it is missing, readable by the owner only. SQLite gives
/// its journal the same mode.
fn create_private(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::stored_tunnel;

    #[test]
    fn inserts_lists_by_name_and_deletes() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        assert_eq!(
            store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), stored_tunnel("bob")]
        );
        assert!(
            matches!(
                store.insert_tunnel(&stored_tunnel("alice")),
                Err(TunnelError::Infrastructure { .. })
            ),
            "names are unique"
        );

        assert!(store.delete_tunnel("alice").unwrap());
        assert!(!store.delete_tunnel("alice").unwrap());
        assert_eq!(store.list_tunnels().unwrap(), [stored_tunnel("bob")]);
    }

    /// Running the migrations twice is a no-op the second time (the
    /// namespaced runner skips already-applied versions).
    #[test]
    fn migrations_are_idempotent() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteTunnelStore::new(pool.clone()).unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let reopened = SqliteTunnelStore::new(pool).unwrap();
        assert_eq!(reopened.list_tunnels().unwrap(), [stored_tunnel("alice")]);
    }

    #[test]
    fn the_file_is_private_and_persists_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SqliteTunnelStore::FILE_NAME);
        SqliteTunnelStore::open(&path)
            .unwrap()
            .insert_tunnel(&stored_tunnel("alice"))
            .unwrap();
        assert_eq!(
            SqliteTunnelStore::open(&path)
                .unwrap()
                .list_tunnels()
                .unwrap(),
            [stored_tunnel("alice")]
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}

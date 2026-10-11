//! The `SqliteTunnelStore` adapter — the `SQLite` implementation of the
//! [`TunnelStore`] port. Opens the relay's own
//! database file, `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db`, as an r2d2 pool
//! of Diesel `SqliteConnection`s (`wildflowerhealthio_persistence::DieselPool`), applies
//! the embedded relay migrations once on construction, and implements the
//! port by delegating to the query bodies in `tunnels`, and the
//! [`ClaimCodeStore`] port by delegating to those in `claim_codes`. Mirrors
//! `collector-rust`'s `SqliteRemotesStore`.
//!
//! Tokens are stored in plain text, since rathole and the HMAC check both
//! need them, so the file is created readable by the owner only. Every call
//! blocks on SQLite; the registry runs them off the async runtime.

use std::path::Path;

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use wildflowerhealthio_persistence::{DieselPool, PooledDieselConnection};

use crate::db::{claim_codes, tunnels};
use crate::domain::{
    ClaimCodeHash, ClaimCodeStore, StoredClaimCode, StoredTunnel, Tunnel, TunnelError, TunnelStore,
};

/// The relay's migration namespace. Applied versions are bookkept
/// per-namespace by [`wildflowerhealthio_persistence::run_diesel_migrations`], the same
/// runner the slices use, though the relay's database holds no other
/// namespace.
const MIGRATION_NAMESPACE: &str = "wildflower_relay";

/// The relay migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteTunnelStore::new`] via
/// [`wildflowerhealthio_persistence::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`].
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
        Self::new(wildflowerhealthio_persistence::open_pool(path)?)
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
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .context("failed to apply relay migrations")?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call
    /// is an independent, freshly-migrated database (see
    /// `wildflowerhealthio_persistence::open_in_memory_pool`).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(wildflowerhealthio_persistence::open_in_memory_pool()?)
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

    fn contains_tunnel(&self, name: &str) -> Result<bool, TunnelError> {
        tunnels::contains_tunnel(&mut self.connection()?, name)
    }

    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<bool, TunnelError> {
        tunnels::insert_tunnel(&mut self.connection()?, stored)
    }

    fn delete_tunnel(&self, name: &str) -> Result<Option<StoredTunnel>, TunnelError> {
        tunnels::delete_tunnel(&mut self.connection()?, name)
    }
}

/// The claim-code port over the same database: thin delegations to the
/// query bodies in `claim_codes`.
impl ClaimCodeStore for SqliteTunnelStore {
    fn insert_claim_code(&self, stored: &StoredClaimCode) -> Result<bool, TunnelError> {
        claim_codes::insert_claim_code(&mut self.connection()?, stored)
    }

    fn take_claim_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<Tunnel>, TunnelError> {
        claim_codes::take_claim_code(&mut self.connection()?, code_hash, now)
    }

    fn delete_expired_claim_codes(&self, now: i64) -> Result<usize, TunnelError> {
        claim_codes::delete_expired_claim_codes(&mut self.connection()?, now)
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

    /// A code hashed `byte` repeated, for `tunnel_name`, expiring at
    /// `expires_at`.
    fn claim_code(byte: u8, tunnel_name: &str, expires_at: i64) -> StoredClaimCode {
        StoredClaimCode {
            code_hash: ClaimCodeHash([byte; 32]),
            tunnel_name: tunnel_name.to_owned(),
            expires_at,
        }
    }

    #[test]
    fn a_claim_code_is_taken_once_while_unexpired_for_its_tunnel() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = claim_code(1, "alice", 1_900);
        assert!(store.insert_claim_code(&code).unwrap());
        assert!(
            !store.insert_claim_code(&claim_code(1, "alice", 5)).unwrap(),
            "hashes are unique"
        );

        assert_eq!(store.take_claim_code(&code.code_hash, 1_900).unwrap(), None);
        assert_eq!(
            store.take_claim_code(&code.code_hash, 1_899).unwrap(),
            Some(stored_tunnel("alice").tunnel)
        );
        assert_eq!(store.take_claim_code(&code.code_hash, 1_000).unwrap(), None);
        let unknown = ClaimCodeHash([2; 32]);
        assert_eq!(store.take_claim_code(&unknown, 1_000).unwrap(), None);
    }

    #[test]
    fn a_claim_code_needs_a_stored_tunnel() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        let refused = store.insert_claim_code(&claim_code(1, "nobody", 1_900));
        assert!(matches!(
            refused.unwrap_err(),
            TunnelError::Infrastructure { .. }
        ));
    }

    #[test]
    fn deleting_a_tunnel_deletes_its_claim_codes() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        store
            .insert_claim_code(&claim_code(1, "alice", 1_900))
            .unwrap();
        store
            .insert_claim_code(&claim_code(2, "bob", 1_900))
            .unwrap();
        store.delete_tunnel("alice").unwrap();
        // Put back under the same name, the tunnel has no codes.
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        assert_eq!(
            store
                .take_claim_code(&ClaimCodeHash([1; 32]), 1_000)
                .unwrap(),
            None
        );
        assert!(store
            .take_claim_code(&ClaimCodeHash([2; 32]), 1_000)
            .unwrap()
            .is_some());
    }

    #[test]
    fn expired_claim_codes_are_deleted() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        for (byte, expires_at) in [(1, 1_000), (2, 1_500), (3, 2_000)] {
            store
                .insert_claim_code(&claim_code(byte, "alice", expires_at))
                .unwrap();
        }
        assert_eq!(store.delete_expired_claim_codes(1_500).unwrap(), 2);
        assert_eq!(store.delete_expired_claim_codes(1_500).unwrap(), 0);
        assert!(store
            .take_claim_code(&ClaimCodeHash([3; 32]), 1_500)
            .unwrap()
            .is_some());
    }

    /// Many threads, each on its own connection to the same file, redeem
    /// the same code at once: exactly one gets the tunnel.
    #[test]
    fn of_concurrent_takes_exactly_one_gets_the_tunnel() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SqliteTunnelStore::open(&dir.path().join(SqliteTunnelStore::FILE_NAME)).unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = claim_code(1, "alice", 1_900);
        store.insert_claim_code(&code).unwrap();
        let barrier = std::sync::Barrier::new(8);
        let taken: Vec<Option<Tunnel>> = std::thread::scope(|scope| {
            let takers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        store.take_claim_code(&code.code_hash, 1_000).unwrap()
                    })
                })
                .collect();
            takers
                .into_iter()
                .map(|taker| taker.join().unwrap())
                .collect()
        });
        assert_eq!(taken.iter().filter(|tunnel| tunnel.is_some()).count(), 1);
    }

    #[test]
    fn inserts_lists_by_name_and_deletes() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        assert!(store.insert_tunnel(&stored_tunnel("bob")).unwrap());
        assert!(store.insert_tunnel(&stored_tunnel("alice")).unwrap());
        assert_eq!(
            store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), stored_tunnel("bob")]
        );
        assert!(store.contains_tunnel("alice").unwrap());
        assert!(!store.contains_tunnel("carol").unwrap());

        let mut taken = stored_tunnel("alice");
        taken.email = "someone-else@example.com".to_owned();
        assert!(!store.insert_tunnel(&taken).unwrap(), "names are unique");
        assert_eq!(
            store.list_tunnels().unwrap()[0],
            stored_tunnel("alice"),
            "a refused insert stores nothing"
        );

        assert_eq!(
            store.delete_tunnel("alice").unwrap(),
            Some(stored_tunnel("alice"))
        );
        assert_eq!(store.delete_tunnel("alice").unwrap(), None);
        assert!(!store.contains_tunnel("alice").unwrap());
        assert_eq!(store.list_tunnels().unwrap(), [stored_tunnel("bob")]);
    }

    /// Running the migrations twice is a no-op the second time (the
    /// namespaced runner skips already-applied versions).
    #[test]
    fn migrations_are_idempotent() {
        let pool = wildflowerhealthio_persistence::open_in_memory_pool().unwrap();
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

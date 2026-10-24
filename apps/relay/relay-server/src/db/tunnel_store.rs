//! The `SqliteTunnelStore` adapter — the `SQLite` implementation of the
//! [`TunnelStore`] port. Opens the relay's own
//! database file, `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db`, as an r2d2 pool
//! of Diesel `SqliteConnection`s (`wildflowerhealthio_persistence::DieselPool`), applies
//! the embedded relay migrations once on construction, and implements the
//! port by delegating to the query bodies in `tunnels`, the
//! [`ClaimCodeStore`] port by delegating to those in `claim_codes`, and the
//! [`ConnectionTotalsStore`] port by delegating to those in
//! `connection_totals`. Mirrors
//! `apps-rust`'s `SqliteAppsStore`.
//!
//! Tokens are stored in plain text, since rathole and the HMAC check both
//! need them, so the file is created readable by the owner only. Every call
//! blocks on SQLite; the registry runs them off the async runtime.

use std::path::Path;

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use wildflowerhealthio_persistence::{DieselPool, PooledDieselConnection};

use crate::db::{claim_codes, connection_totals, tunnels};
use crate::domain::{
    ClaimCodeHash, ClaimCodeStore, ClaimCodeTarget, ConnectionTotalsStore, HourlyCount,
    StoredClaimCode, StoredTunnel, Tunnel, TunnelError, TunnelStore,
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

    /// Run `sql` on the database — for tests that break it on purpose.
    #[cfg(test)]
    pub(crate) fn execute(&self, sql: &str) {
        use diesel::RunQueryDsl;
        diesel::sql_query(sql)
            .execute(&mut self.pool.get().expect("a connection"))
            .expect("the statement runs");
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

    fn replace_token(&self, tunnel: &Tunnel) -> Result<Option<StoredTunnel>, TunnelError> {
        tunnels::replace_token(&mut self.connection()?, tunnel)
    }
}

/// The claim-code port over the same database: thin delegations to the
/// query bodies in `claim_codes`.
impl ClaimCodeStore for SqliteTunnelStore {
    fn insert_claim_code(&self, stored: &StoredClaimCode) -> Result<bool, TunnelError> {
        claim_codes::insert_claim_code(&mut self.connection()?, stored)
    }

    fn claim_code_target(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<ClaimCodeTarget>, TunnelError> {
        claim_codes::claim_code_target(&mut self.connection()?, code_hash, now)
    }

    fn take_preset_claim_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<Tunnel>, TunnelError> {
        claim_codes::take_preset_claim_code(&mut self.connection()?, code_hash, now)
    }

    fn take_open_claim_code_for_tunnel(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
        tunnel: &StoredTunnel,
    ) -> Result<Option<StoredClaimCode>, TunnelError> {
        claim_codes::take_open_claim_code_for_tunnel(
            &mut self.connection()?,
            code_hash,
            now,
            tunnel,
        )
    }

    fn delete_expired_claim_codes(&self, now: i64) -> Result<usize, TunnelError> {
        claim_codes::delete_expired_claim_codes(&mut self.connection()?, now)
    }
}

/// The hourly connection totals over the same database: thin delegations to
/// the query bodies in `connection_totals`.
impl ConnectionTotalsStore for SqliteTunnelStore {
    fn add_connection_totals(&self, counts: &[HourlyCount]) -> Result<(), TunnelError> {
        connection_totals::add_connection_totals(&mut self.connection()?, counts)
    }

    fn delete_connection_totals_before(&self, hour: i64) -> Result<usize, TunnelError> {
        connection_totals::delete_connection_totals_before(&mut self.connection()?, hour)
    }

    fn connection_totals_since(&self, hour: i64) -> Result<Vec<HourlyCount>, TunnelError> {
        connection_totals::connection_totals_since(&mut self.connection()?, hour)
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
    use crate::settings::Secret;

    /// A code hashed `byte` repeated, for the tunnel named `tunnel_name`,
    /// expiring at `expires_at`.
    fn preset_code(byte: u8, tunnel_name: &str, expires_at: i64) -> StoredClaimCode {
        StoredClaimCode {
            code_hash: ClaimCodeHash([byte; 32]),
            target: ClaimCodeTarget::Preset {
                tunnel_name: tunnel_name.to_owned(),
            },
            expires_at,
        }
    }

    /// A code hashed `byte` repeated, naming no tunnel, expiring at
    /// `expires_at`.
    fn open_code(byte: u8, expires_at: i64) -> StoredClaimCode {
        StoredClaimCode {
            code_hash: ClaimCodeHash([byte; 32]),
            target: ClaimCodeTarget::Open,
            expires_at,
        }
    }

    #[test]
    fn a_code_s_target_is_read_while_it_is_unexpired() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let preset = preset_code(1, "alice", 1_900);
        let open = open_code(2, 1_900);
        assert!(store.insert_claim_code(&preset).unwrap());
        assert!(store.insert_claim_code(&open).unwrap());
        for code in [&preset, &open] {
            assert_eq!(
                store.claim_code_target(&code.code_hash, 1_899).unwrap(),
                Some(code.target.clone())
            );
            assert_eq!(
                store.claim_code_target(&code.code_hash, 1_900).unwrap(),
                None
            );
        }
        assert_eq!(
            store
                .claim_code_target(&ClaimCodeHash([3; 32]), 1_000)
                .unwrap(),
            None
        );
    }

    /// Hashes are unique across both kinds, whichever is stored first.
    #[test]
    fn no_two_codes_share_a_hash() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        assert!(store
            .insert_claim_code(&preset_code(1, "alice", 1_900))
            .unwrap());
        assert!(!store.insert_claim_code(&preset_code(1, "bob", 5)).unwrap());
        assert!(!store.insert_claim_code(&open_code(1, 5)).unwrap());
        assert!(store.insert_claim_code(&open_code(2, 1_900)).unwrap());
        assert!(!store.insert_claim_code(&preset_code(2, "bob", 5)).unwrap());
        assert_eq!(
            store
                .claim_code_target(&ClaimCodeHash([1; 32]), 1_000)
                .unwrap(),
            Some(preset_code(1, "alice", 1_900).target),
            "the first stays"
        );
    }

    #[test]
    fn a_preset_code_is_taken_once_while_unexpired_for_its_tunnel() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = preset_code(1, "alice", 1_900);
        assert!(store.insert_claim_code(&code).unwrap());

        assert_eq!(
            store
                .take_preset_claim_code(&code.code_hash, 1_900)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .take_preset_claim_code(&code.code_hash, 1_899)
                .unwrap(),
            Some(stored_tunnel("alice").tunnel)
        );
        assert_eq!(
            store
                .take_preset_claim_code(&code.code_hash, 1_000)
                .unwrap(),
            None
        );
    }

    /// Each take takes only its own kind of code.
    #[test]
    fn a_take_leaves_the_other_kind_of_code_alone() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let preset = preset_code(1, "alice", 1_900);
        let open = open_code(2, 1_900);
        store.insert_claim_code(&preset).unwrap();
        store.insert_claim_code(&open).unwrap();
        assert_eq!(
            store
                .take_preset_claim_code(&open.code_hash, 1_000)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .take_open_claim_code_for_tunnel(&preset.code_hash, 1_000, &stored_tunnel("bob"))
                .unwrap(),
            None
        );
        assert_eq!(store.list_tunnels().unwrap(), [stored_tunnel("alice")]);
        for code in [&preset, &open] {
            assert!(store
                .claim_code_target(&code.code_hash, 1_000)
                .unwrap()
                .is_some());
        }
    }

    #[test]
    fn a_new_preset_code_replaces_the_tunnels_earlier_one() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let earlier = preset_code(1, "alice", 1_900);
        let later = preset_code(2, "alice", 2_000);
        assert!(store.insert_claim_code(&earlier).unwrap());
        assert!(store.insert_claim_code(&later).unwrap());

        assert_eq!(
            store
                .take_preset_claim_code(&earlier.code_hash, 1_000)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .take_preset_claim_code(&later.code_hash, 1_999)
                .unwrap(),
            Some(stored_tunnel("alice").tunnel)
        );
    }

    #[test]
    fn open_codes_add_up() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        for byte in 1..=3 {
            assert!(store.insert_claim_code(&open_code(byte, 1_900)).unwrap());
        }
        assert_eq!(store.delete_expired_claim_codes(1_900).unwrap(), 3);
    }

    #[test]
    fn a_preset_code_needs_a_stored_tunnel() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        let refused = store.insert_claim_code(&preset_code(1, "nobody", 1_900));
        assert!(matches!(
            refused.unwrap_err(),
            TunnelError::Infrastructure { .. }
        ));
    }

    #[test]
    fn deleting_a_tunnel_deletes_its_claim_code() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        store
            .insert_claim_code(&preset_code(1, "alice", 1_900))
            .unwrap();
        store
            .insert_claim_code(&preset_code(2, "bob", 1_900))
            .unwrap();
        store.insert_claim_code(&open_code(3, 1_900)).unwrap();
        store.delete_tunnel("alice").unwrap();
        // Put back under the same name, the tunnel has no codes.
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        assert_eq!(
            store
                .take_preset_claim_code(&ClaimCodeHash([1; 32]), 1_000)
                .unwrap(),
            None
        );
        assert!(store
            .take_preset_claim_code(&ClaimCodeHash([2; 32]), 1_000)
            .unwrap()
            .is_some());
        assert_eq!(
            store
                .claim_code_target(&ClaimCodeHash([3; 32]), 1_000)
                .unwrap(),
            Some(ClaimCodeTarget::Open)
        );
    }

    #[test]
    fn expired_claim_codes_are_deleted() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        for (byte, name, expires_at) in [(1, "alice", 1_000), (3, "carol", 2_000)] {
            store.insert_tunnel(&stored_tunnel(name)).unwrap();
            store
                .insert_claim_code(&preset_code(byte, name, expires_at))
                .unwrap();
        }
        store.insert_claim_code(&open_code(2, 1_500)).unwrap();
        assert_eq!(store.delete_expired_claim_codes(1_500).unwrap(), 2);
        assert_eq!(store.delete_expired_claim_codes(1_500).unwrap(), 0);
        assert!(store
            .take_preset_claim_code(&ClaimCodeHash([3; 32]), 1_500)
            .unwrap()
            .is_some());
    }

    #[test]
    fn an_open_code_is_taken_once_while_unexpired_storing_its_tunnel() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        let code = open_code(1, 1_900);
        assert!(store.insert_claim_code(&code).unwrap());

        let bob = stored_tunnel("bob");
        assert_eq!(
            store
                .take_open_claim_code_for_tunnel(&code.code_hash, 1_900, &bob)
                .unwrap(),
            None
        );
        assert!(
            store.list_tunnels().unwrap().is_empty(),
            "expired: no tunnel"
        );
        assert_eq!(
            store
                .take_open_claim_code_for_tunnel(&code.code_hash, 1_899, &bob)
                .unwrap(),
            Some(code.clone())
        );
        assert_eq!(store.list_tunnels().unwrap(), [bob]);
        let carol = stored_tunnel("carol");
        assert_eq!(
            store
                .take_open_claim_code_for_tunnel(&code.code_hash, 1_000, &carol)
                .unwrap(),
            None,
            "burned"
        );
        assert_eq!(
            store.claim_code_target(&code.code_hash, 1_000).unwrap(),
            None
        );
    }

    /// A tunnel name already stored fails the redemption and leaves the
    /// code to redeem.
    #[test]
    fn a_taken_name_rolls_the_redemption_back() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = open_code(1, 1_900);
        store.insert_claim_code(&code).unwrap();
        let mut taken = stored_tunnel("alice");
        taken.email = "someone-else@example.com".to_owned();
        let refused = store.take_open_claim_code_for_tunnel(&code.code_hash, 1_000, &taken);
        assert!(matches!(
            refused.unwrap_err(),
            TunnelError::Infrastructure { .. }
        ));
        assert_eq!(
            store.claim_code_target(&code.code_hash, 1_000).unwrap(),
            Some(ClaimCodeTarget::Open)
        );
        assert_eq!(store.list_tunnels().unwrap(), [stored_tunnel("alice")]);
    }

    /// Many threads, each on its own connection to the same file, redeem
    /// the same open code at once, each for its own tunnel: exactly one
    /// stores its tunnel.
    #[test]
    fn of_concurrent_open_code_takes_exactly_one_stores_its_tunnel() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SqliteTunnelStore::open(&dir.path().join(SqliteTunnelStore::FILE_NAME)).unwrap();
        let code = open_code(1, 1_900);
        store.insert_claim_code(&code).unwrap();
        let barrier = std::sync::Barrier::new(8);
        let taken: Vec<bool> = std::thread::scope(|scope| {
            let takers: Vec<_> = (0..8)
                .map(|taker| {
                    let (store, barrier, code) = (&store, &barrier, &code);
                    scope.spawn(move || {
                        let tunnel = stored_tunnel(&format!("taker{taker}"));
                        barrier.wait();
                        store
                            .take_open_claim_code_for_tunnel(&code.code_hash, 1_000, &tunnel)
                            .unwrap()
                            .is_some()
                    })
                })
                .collect();
            takers
                .into_iter()
                .map(|taker| taker.join().unwrap())
                .collect()
        });
        assert_eq!(taken.iter().filter(|&&won| won).count(), 1);
        assert_eq!(store.list_tunnels().unwrap().len(), 1);
    }

    /// Many threads, each on its own connection to the same file, redeem
    /// the same preset code at once: exactly one gets the tunnel.
    #[test]
    fn of_concurrent_preset_code_takes_exactly_one_gets_the_tunnel() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SqliteTunnelStore::open(&dir.path().join(SqliteTunnelStore::FILE_NAME)).unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = preset_code(1, "alice", 1_900);
        store.insert_claim_code(&code).unwrap();
        let barrier = std::sync::Barrier::new(8);
        let taken: Vec<Option<Tunnel>> = std::thread::scope(|scope| {
            let takers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        store
                            .take_preset_claim_code(&code.code_hash, 1_000)
                            .unwrap()
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

    /// The relay migrations before `0004_open_claim_codes`, which rebuilds
    /// `claim_codes`.
    struct BeforeOpenClaimCodes;

    impl diesel::migration::MigrationSource<diesel::sqlite::Sqlite> for BeforeOpenClaimCodes {
        fn migrations(
            &self,
        ) -> diesel::migration::Result<
            Vec<Box<dyn diesel::migration::Migration<diesel::sqlite::Sqlite>>>,
        > {
            let mut migrations = MIGRATIONS.migrations()?;
            migrations.retain(|migration| migration.name().version().to_string().as_str() < "0004");
            Ok(migrations)
        }
    }

    /// A tunnel's claim code stored before `claim_codes` was rebuilt
    /// redeems for it after.
    #[test]
    fn a_claim_code_stored_before_the_rebuild_still_redeems() {
        use diesel::connection::SimpleConnection;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SqliteTunnelStore::FILE_NAME);
        let pool = wildflowerhealthio_persistence::open_pool(&path).unwrap();
        {
            let mut conn = pool.get().unwrap();
            wildflowerhealthio_persistence::run_diesel_migrations(
                &mut conn,
                MIGRATION_NAMESPACE,
                BeforeOpenClaimCodes,
            )
            .unwrap();
            let hash = "01".repeat(32);
            conn.batch_execute(&format!(
                "INSERT INTO tunnels (name, email, token, created_at) \
                 VALUES ('alice', 'alice@example.com', 'alice-token', 1700000000); \
                 INSERT INTO claim_codes (tunnel_name, code_hash, expires_at) \
                 VALUES ('alice', X'{hash}', 1900);"
            ))
            .unwrap();
        }
        let store = SqliteTunnelStore::new(pool).unwrap();
        assert_eq!(
            store
                .claim_code_target(&ClaimCodeHash([1; 32]), 1_000)
                .unwrap(),
            Some(preset_code(1, "alice", 1_900).target)
        );
        assert_eq!(
            store
                .take_preset_claim_code(&ClaimCodeHash([1; 32]), 1_000)
                .unwrap(),
            Some(stored_tunnel("alice").tunnel)
        );
        assert!(store.insert_claim_code(&open_code(2, 1_900)).unwrap());
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

    #[test]
    fn replacing_a_token_returns_the_tunnel_as_it_was() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let reissued = Tunnel {
            name: "alice".to_owned(),
            token: Secret::new("alice-new-token".to_owned()),
        };
        assert_eq!(
            store.replace_token(&reissued).unwrap(),
            Some(stored_tunnel("alice"))
        );
        let mut expected = stored_tunnel("alice");
        expected.tunnel = reissued.clone();
        assert_eq!(store.list_tunnels().unwrap(), [expected]);

        let unknown = Tunnel {
            name: "nobody".to_owned(),
            token: Secret::new("x".to_owned()),
        };
        assert_eq!(store.replace_token(&unknown).unwrap(), None);
        assert_eq!(
            store.list_tunnels().unwrap().len(),
            1,
            "a miss stores nothing"
        );
    }

    /// A claim code reads its tunnel's token when it is redeemed, so a code
    /// issued before the token was replaced redeems for the new one.
    #[test]
    fn a_claim_code_redeems_for_the_token_stored_when_it_is_taken() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = preset_code(1, "alice", 1_900);
        store.insert_claim_code(&code).unwrap();
        let reissued = Tunnel {
            name: "alice".to_owned(),
            token: Secret::new("alice-new-token".to_owned()),
        };
        store.replace_token(&reissued).unwrap();
        assert_eq!(
            store
                .take_preset_claim_code(&code.code_hash, 1_000)
                .unwrap(),
            Some(reissued)
        );
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

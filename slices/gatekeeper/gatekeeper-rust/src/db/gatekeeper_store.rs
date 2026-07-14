//! The `SqliteGatekeeperStore` adapter — the `SQLite` implementation of the
//! [`GatekeeperStore`](crate::domain::GatekeeperStore) port. Holds the app-wide
//! r2d2 pool of Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto
//! the shared database file, applies the embedded gatekeeper migrations once on
//! construction (under this slice's [`MIGRATION_NAMESPACE`]), and implements the
//! port by checking a connection out of the pool and delegating to the
//! per-concern query bodies in the sibling `db/*` modules. Mirrors
//! `collector-rust`'s `SqliteRemotesStore` and `tunnel-rust`'s
//! `SqliteTunnelStore`, scaled to the gatekeeper's six persistence concerns.

use anyhow::Context;
use chrono::{DateTime, Utc};
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};
use url::Url;

use crate::db::{
    authorization_codes, authorization_requests, clients, grants, refresh_tokens, signing_keys,
};
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GatekeeperStore;

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`persistence_rust::run_diesel_migrations`], so
/// gatekeeper's `0001` and another diesel slice's `0001` never collide — the
/// stock diesel harness records versions in a single un-namespaced
/// `__diesel_schema_migrations` table, where a second diesel slice's `0001`
/// would silently mask the first.
const MIGRATION_NAMESPACE: &str = "gatekeeper";

/// The gatekeeper migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteGatekeeperStore::new`] via
/// [`persistence_rust::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`]
/// (see that runner for why the stock diesel harness can't be shared across
/// slices). Migration `0001` deliberately DROPs the tables the retired rusqlite
/// migrations managed (destructive rebaseline — see its header), `0002` creates
/// the cross-kind `grants` VIEW over the two concrete grant tables (its own
/// migration so it can be up/down'd independently), and `0003` seeds the SMART
/// sample-app clients; because each migration runs only once per database, an
/// upgrade neither re-drops nor re-seeds.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`GatekeeperStore`] port. Cheap to clone (the
/// pool is an `Arc` inside), so it drops straight into the axum state.
#[derive(Clone)]
pub struct SqliteGatekeeperStore {
    // The app-wide r2d2 pool onto the shared database file, built and owned by
    // the host (`persistence_rust::open_pool`) — the same pool collector's and
    // tunnel's stores ride. Diesel's connection API is `&mut`, so each call
    // checks a connection out of the pool rather than sharing one behind a
    // mutex; the pool (an `Arc` inside) makes the store cheap to clone into the
    // axum state. These are additional openers onto the same file the host's
    // rusqlite `persistence-rust::Connection` serves the remaining rusqlite
    // slices from — SQLite permits multiple connections per file; the pool's
    // `busy_timeout` pragma rides out the brief write locks any connection takes
    // (see `persistence_rust::open_pool`).
    pool: DieselPool,
}

impl SqliteGatekeeperStore {
    /// Wrap the host-owned connection `pool` and apply pending gatekeeper
    /// migrations once, on a single checked-out connection, under
    /// [`MIGRATION_NAMESPACE`]. The host builds the app-wide pool (via
    /// `persistence_rust::open_pool`) on the same file its rusqlite connection
    /// opens for the other slices; both coexist (see the `pool` field).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run gatekeeper migrations")?;
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .context("failed to apply gatekeeper migrations")?;
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
    /// port's opaque [`GatekeeperError::Infrastructure`] — the shared first step
    /// of every method in the port impl below. Each query in the sibling `db/*`
    /// modules runs on one of these, checked out per call — diesel's connection
    /// API is `&mut`, so the store hands out a fresh connection rather than
    /// sharing one.
    fn connection(&self) -> Result<PooledDieselConnection, GatekeeperError> {
        self.pool
            .get()
            .map_err(|e| GatekeeperError::infrastructure("failed to check out a connection", e))
    }

    /// The pool, for tests that tamper with stored rows via raw SQL to prove the
    /// column mappings reject an out-of-domain stored value as a typed read error
    /// (rather than a panic) at the read boundary.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The `SQLite` implementation of the port: each method checks a connection out
/// of the pool (via [`connection`](SqliteGatekeeperStore::connection)) and hands
/// it to the matching query body in the sibling `db/*` modules. The bodies live
/// there so this file stays the migration + pool handle, and the query SQL stays
/// next to the row type it maps. Every method returns the port's PRIMITIVE shape
/// — absence as `None`, affected-row outcome as `bool`, the three-state consume
/// as [`RefreshTokenConsumeOutcome`] — leaving the `*NotFound` semantics to
/// [`crate::domain::actions`].
///
/// Multi-statement operations (the prune-then-insert of
/// `insert_authorization_request`, and every transaction body) run all their
/// statements on the ONE connection checked out here, so the atomicity the query
/// bodies rely on holds.
impl GatekeeperStore for SqliteGatekeeperStore {
    // ----- clients -------------------------------------------------------

    fn client_by_id(&self, client_id: &str) -> Result<Option<Client>, GatekeeperError> {
        clients::client_by_id(&mut self.connection()?, client_id)
    }

    fn register_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        clients::register_client(&mut self.connection()?, client)
    }

    fn upsert_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        clients::upsert_client(&mut self.connection()?, client)
    }

    // ----- signing keys --------------------------------------------------

    fn all_signing_keys(&self) -> Result<Vec<SigningKey>, GatekeeperError> {
        signing_keys::all_signing_keys(&mut self.connection()?)
    }

    fn active_signing_key(&self) -> Result<Option<SigningKey>, GatekeeperError> {
        signing_keys::active_signing_key(&mut self.connection()?)
    }

    fn has_active_signing_key(&self) -> Result<bool, GatekeeperError> {
        signing_keys::has_active_signing_key(&mut self.connection()?)
    }

    fn insert_signing_key(&self, key: &SigningKey) -> Result<(), GatekeeperError> {
        signing_keys::insert_signing_key(&mut self.connection()?, key)
    }

    // ----- authorization requests ----------------------------------------

    fn authorization_request_by_id(
        &self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        authorization_requests::authorization_request_by_id(&mut self.connection()?, id)
    }

    fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        authorization_requests::authorization_request_by_user_code(
            &mut self.connection()?,
            user_code,
        )
    }

    fn pending_authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        authorization_requests::pending_authorization_request_by_user_code(
            &mut self.connection()?,
            user_code,
        )
    }

    fn oldest_pending_device_user_code(&self) -> Result<Option<String>, GatekeeperError> {
        authorization_requests::oldest_pending_device_user_code(&mut self.connection()?)
    }

    fn insert_authorization_request(
        &self,
        request: &AuthorizationRequest,
    ) -> Result<(), GatekeeperError> {
        authorization_requests::insert_authorization_request(&mut self.connection()?, request)
    }

    fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError> {
        authorization_requests::approve_authorization_request(
            &mut self.connection()?,
            id,
            granted_scopes,
            patient,
            device_name,
        )
    }

    fn deny_authorization_request(&self, id: &str) -> Result<(), GatekeeperError> {
        authorization_requests::deny_authorization_request(&mut self.connection()?, id)
    }

    fn consume_approved_authorization_request(&self, id: &str) -> Result<bool, GatekeeperError> {
        authorization_requests::consume_approved_authorization_request(&mut self.connection()?, id)
    }

    fn record_device_poll(
        &self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        authorization_requests::record_device_poll(&mut self.connection()?, id, polled_at)
    }

    // ----- authorization codes -------------------------------------------

    fn redeem_authorization_code(
        &self,
        code: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        authorization_codes::redeem_authorization_code(&mut self.connection()?, code)
    }

    fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        authorization_codes::authorization_code_by_request_id(&mut self.connection()?, request_id)
    }

    fn issue_authorization_code(&self, code: &AuthorizationCode) -> Result<(), GatekeeperError> {
        authorization_codes::issue_authorization_code(&mut self.connection()?, code)
    }

    // ----- refresh-token families ----------------------------------------

    fn insert_refresh_token_family(
        &self,
        family: &RefreshTokenFamily,
        first_token: &RefreshToken,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::insert_refresh_token_family(&mut self.connection()?, family, first_token)
    }

    fn insert_refresh_token(&self, token: &RefreshToken) -> Result<(), GatekeeperError> {
        refresh_tokens::insert_refresh_token(&mut self.connection()?, token)
    }

    fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
        refresh_tokens::refresh_token_with_family_by_hash(&mut self.connection()?, token_hash)
    }

    fn refresh_token_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<RefreshToken>, GatekeeperError> {
        refresh_tokens::refresh_token_by_hash(&mut self.connection()?, token_hash)
    }

    fn consume_refresh_token(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
        refresh_tokens::consume_refresh_token(&mut self.connection()?, token_hash, now)
    }

    fn rotate_refresh_token(
        &self,
        presented_hash: &str,
        successor: &RefreshToken,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
        refresh_tokens::rotate_refresh_token(
            &mut self.connection()?,
            presented_hash,
            successor,
            now,
        )
    }

    fn expire_refresh_token_family(
        &self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::expire_refresh_token_family(&mut self.connection()?, family_id, now)
    }

    fn expire_refresh_token_families_for_client(
        &self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::expire_refresh_token_families_for_client(
            &mut self.connection()?,
            client_id,
            now,
        )
    }

    fn expire_refresh_token_families_for_authorization_code(
        &self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::expire_refresh_token_families_for_authorization_code(
            &mut self.connection()?,
            authorization_code_hash,
            now,
        )
    }

    // ----- grants --------------------------------------------------------

    fn all_grants(&self) -> Result<Vec<Grant>, GatekeeperError> {
        grants::all_grants(&mut self.connection()?)
    }

    fn grant_by_id(&self, id: &str) -> Result<Option<Grant>, GatekeeperError> {
        grants::grant_by_id(&mut self.connection()?, id)
    }

    fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
        grants::grant_by_client_and_redirect(&mut self.connection()?, client_id, redirect_uri)
    }

    fn device_grant_by_client_and_device_name(
        &self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError> {
        grants::device_grant_by_client_and_device_name(
            &mut self.connection()?,
            client_id,
            device_name,
        )
    }

    fn create_grant(&self, grant: &Grant) -> Result<(), GatekeeperError> {
        grants::create_grant(&mut self.connection()?, grant)
    }

    fn upsert_grant(
        &self,
        client_id: &str,
        redirect_uri: &Url,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        grants::upsert_grant(
            &mut self.connection()?,
            client_id,
            redirect_uri,
            scopes,
            patient,
            now,
        )
    }

    fn upsert_device_grant(
        &self,
        client_id: &str,
        device_name: &str,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        grants::upsert_device_grant(
            &mut self.connection()?,
            client_id,
            device_name,
            scopes,
            patient,
            now,
        )
    }

    fn revoke_grant_and_expire_client_families(
        &self,
        grant_id: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError> {
        grants::revoke_grant_and_expire_client_families(
            &mut self.connection()?,
            grant_id,
            client_id,
            now,
        )
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;
    use diesel::sqlite::SqliteConnection;

    use super::{MIGRATIONS, MIGRATION_NAMESPACE};
    use crate::db::SqliteGatekeeperStore;
    use crate::domain::GatekeeperStore as _;

    #[derive(QueryableByName)]
    struct Name {
        #[diesel(sql_type = diesel::sql_types::Text)]
        name: String,
    }

    /// Running the migrations twice is a no-op the second time (the namespaced
    /// runner skips already-applied versions) and every expected table — plus
    /// the `grants` view — exists afterwards, so opening an existing database
    /// never re-drops or errors.
    #[test]
    fn migrations_are_idempotent_and_create_the_schema() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .expect("first run");
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .expect("second run");
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
        use diesel::connection::SimpleConnection;

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

        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .expect("rebaseline");

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
        let a = SqliteGatekeeperStore::open_in_memory().expect("store a");
        let b = SqliteGatekeeperStore::open_in_memory().expect("store b");
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

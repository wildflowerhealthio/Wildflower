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
use diesel::connection::Connection;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};
use url::Url;

use crate::db::{
    authorization_codes, authorization_requests, clients, grants, refresh_tokens, signing_keys,
};
use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::pending_consent::PendingConsentHead;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::{GatekeeperStore, GatekeeperTx};

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
/// migration so it can be up/down'd independently), `0003` seeds the SMART
/// sample-app clients, and `0004` / `0005` each register one first-party SMART
/// app's client — one migration per app, matching the per-app seed migrations in
/// the apps slice. `0006` renames those two (`wildflower-medication` →
/// `medications-app`, `wildflower-web-trace` → `web-trace-app`, keeping the
/// `client_id == app id` invariant the redirect resolver needs) and adds their
/// published-site redirect URI now that they launch as cloud apps; `0007` seeds
/// the server-docs API console's client. Because each migration runs only once
/// per database, an upgrade neither re-drops nor re-seeds.
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

/// A [`GatekeeperTx`] over one checked-out diesel connection — the `SQLite`
/// primitive handle [`SqliteGatekeeperStore`] hands to a closure. Each method
/// delegates to the matching query body in the sibling `db/*` modules, passing
/// the wrapped `&mut SqliteConnection`; the bodies live there so the query SQL
/// stays next to the row type it maps and this file stays the migration + pool
/// handle plus the transaction runners. When the closure runs inside
/// [`GatekeeperStore::transaction`] / [`immediate_transaction`] the connection is
/// already in a transaction, so the self-contained `expire_*` bodies open
/// savepoints rather than nested `BEGIN`s.
///
/// `pub` only because it is the `SQLite` adapter's [`GatekeeperStore::Tx`]
/// associated type (a public trait's associated type is part of the public
/// interface); the field and every method are crate-internal, so out-of-crate
/// callers can name the type but do nothing with it except through
/// [`GatekeeperTx`].
pub struct SqliteGatekeeperTx<'a> {
    conn: &'a mut SqliteConnection,
}

impl GatekeeperTx for SqliteGatekeeperTx<'_> {
    // ----- clients -------------------------------------------------------

    fn client_by_id(&mut self, client_id: &str) -> Result<Option<Client>, GatekeeperError> {
        clients::client_by_id(self.conn, client_id)
    }

    fn upsert_client(&mut self, client: &Client) -> Result<(), GatekeeperError> {
        clients::upsert_client(self.conn, client)
    }

    // ----- signing keys --------------------------------------------------

    fn all_signing_keys(&mut self) -> Result<Vec<SigningKey>, GatekeeperError> {
        signing_keys::all_signing_keys(self.conn)
    }

    fn active_signing_key(&mut self) -> Result<Option<SigningKey>, GatekeeperError> {
        signing_keys::active_signing_key(self.conn)
    }

    fn has_active_signing_key(&mut self) -> Result<bool, GatekeeperError> {
        signing_keys::has_active_signing_key(self.conn)
    }

    fn insert_signing_key(&mut self, key: &SigningKey) -> Result<(), GatekeeperError> {
        signing_keys::insert_signing_key(self.conn, key)
    }

    // ----- authorization requests ----------------------------------------

    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        authorization_requests::authorization_request_by_id(self.conn, id)
    }

    fn authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        authorization_requests::authorization_request_by_user_code(self.conn, user_code)
    }

    fn pending_authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        authorization_requests::pending_authorization_request_by_user_code(self.conn, user_code)
    }

    fn oldest_pending_consent_head(
        &mut self,
    ) -> Result<Option<PendingConsentHead>, GatekeeperError> {
        authorization_requests::oldest_pending_consent_head(self.conn)
    }

    fn insert_authorization_request(
        &mut self,
        request: &AuthorizationRequest,
    ) -> Result<(), GatekeeperError> {
        authorization_requests::insert_authorization_request(self.conn, request)
    }

    fn approve_authorization_request(
        &mut self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError> {
        authorization_requests::approve_authorization_request(
            self.conn,
            id,
            granted_scopes,
            patient,
            device_name,
        )
    }

    fn deny_authorization_request(&mut self, id: &str) -> Result<bool, GatekeeperError> {
        authorization_requests::deny_authorization_request(self.conn, id)
    }

    fn consume_approved_authorization_request(
        &mut self,
        id: &str,
    ) -> Result<bool, GatekeeperError> {
        authorization_requests::consume_approved_authorization_request(self.conn, id)
    }

    fn record_device_poll(
        &mut self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        authorization_requests::record_device_poll(self.conn, id, polled_at)
    }

    // ----- authorization codes -------------------------------------------

    fn redeem_authorization_code(
        &mut self,
        code: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
        authorization_codes::redeem_authorization_code(self.conn, code)
    }

    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
        authorization_codes::authorization_code_by_request_id(self.conn, request_id)
    }

    fn issue_authorization_code(
        &mut self,
        code: &IssuedAuthorizationCode,
    ) -> Result<(), GatekeeperError> {
        authorization_codes::issue_authorization_code(self.conn, code)
    }

    // ----- retention ------------------------------------------------------

    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError> {
        authorization_requests::delete_authorization_requests_expired_before(self.conn, cutoff)
    }

    fn delete_authorization_codes_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError> {
        authorization_codes::delete_authorization_codes_expired_before(self.conn, cutoff)
    }

    fn delete_refresh_token_families_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError> {
        refresh_tokens::delete_refresh_token_families_expired_before(self.conn, cutoff)
    }

    // ----- refresh-token families ----------------------------------------

    fn insert_refresh_token_family_row(
        &mut self,
        family: &RefreshTokenFamily,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::insert_refresh_token_family_row(self.conn, family)
    }

    fn insert_refresh_token(&mut self, token: &RefreshToken) -> Result<(), GatekeeperError> {
        refresh_tokens::insert_refresh_token(self.conn, token)
    }

    fn refresh_token_with_family_by_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
        refresh_tokens::refresh_token_with_family_by_hash(self.conn, token_hash)
    }

    fn stamp_refresh_token_consumed_if_live(
        &mut self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError> {
        refresh_tokens::stamp_refresh_token_consumed_if_live(self.conn, token_hash, now)
    }

    fn refresh_token_exists(&mut self, token_hash: &str) -> Result<bool, GatekeeperError> {
        refresh_tokens::refresh_token_exists(self.conn, token_hash)
    }

    fn expire_refresh_token_family(
        &mut self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::expire_refresh_token_family(self.conn, family_id, now)
    }

    fn expire_refresh_token_families_for_client(
        &mut self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::expire_refresh_token_families_for_client(self.conn, client_id, now)
    }

    fn expire_refresh_token_families_for_authorization_code(
        &mut self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        refresh_tokens::expire_refresh_token_families_for_authorization_code(
            self.conn,
            authorization_code_hash,
            now,
        )
    }

    // ----- grants --------------------------------------------------------

    fn all_grants(&mut self) -> Result<Vec<Grant>, GatekeeperError> {
        grants::all_grants(self.conn)
    }

    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, GatekeeperError> {
        grants::grant_by_id(self.conn, id)
    }

    fn grant_by_client_and_redirect(
        &mut self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
        grants::grant_by_client_and_redirect(self.conn, client_id, redirect_uri)
    }

    fn device_grant_by_client_and_device_name(
        &mut self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError> {
        grants::device_grant_by_client_and_device_name(self.conn, client_id, device_name)
    }

    fn create_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError> {
        grants::create_authorization_code_grant(self.conn, grant)
    }

    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), GatekeeperError> {
        grants::create_device_grant(self.conn, grant)
    }

    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError> {
        grants::update_authorization_code_grant(self.conn, grant)
    }

    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), GatekeeperError> {
        grants::update_device_grant(self.conn, grant)
    }

    fn delete_authorization_code_grant(&mut self, id: &str) -> Result<bool, GatekeeperError> {
        grants::delete_authorization_code_grant(self.conn, id)
    }

    fn delete_device_grant(&mut self, id: &str) -> Result<bool, GatekeeperError> {
        grants::delete_device_grant(self.conn, id)
    }
}

/// The `SQLite` implementation of the transaction seam. [`with_connection`] hands
/// a [`SqliteGatekeeperTx`] over a checked-out connection in autocommit;
/// [`transaction`] / [`immediate_transaction`] wrap that same handle in a diesel
/// `BEGIN` / `BEGIN IMMEDIATE`, committing on `Ok` and rolling back on `Err`. The
/// standalone-convenience default methods (inherited from [`GatekeeperStore`])
/// all route through [`with_connection`], so a lone read never takes a write lock;
/// the composed domain actions pick [`transaction`] or [`immediate_transaction`]
/// per their atomicity needs.
///
/// [`with_connection`]: GatekeeperStore::with_connection
/// [`transaction`]: GatekeeperStore::transaction
/// [`immediate_transaction`]: GatekeeperStore::immediate_transaction
impl GatekeeperStore for SqliteGatekeeperStore {
    type Tx<'a> = SqliteGatekeeperTx<'a>;

    fn with_connection<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        let mut conn = self.connection()?;
        let mut tx = SqliteGatekeeperTx { conn: &mut conn };
        f(&mut tx)
    }

    fn transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        let mut conn = self.connection()?;
        // Deref to the concrete `SqliteConnection` up front so both this and
        // `immediate_transaction` hand `f` the same `&mut SqliteConnection` the
        // `db/*` query bodies expect.
        let sqlite: &mut SqliteConnection = &mut conn;
        sqlite.transaction(|conn| {
            let mut tx = SqliteGatekeeperTx { conn };
            f(&mut tx)
        })
    }

    fn immediate_transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        let mut conn = self.connection()?;
        let sqlite: &mut SqliteConnection = &mut conn;
        sqlite.immediate_transaction(|conn| {
            let mut tx = SqliteGatekeeperTx { conn };
            f(&mut tx)
        })
    }
}

// Lets [`GatekeeperStore::transaction`] / [`immediate_transaction`] use
// `GatekeeperError` as the diesel transaction error type: diesel requires
// `E: From<diesel::result::Error>` even though `f`'s body maps its own query
// errors, because a `BEGIN` / `COMMIT` / `ROLLBACK` failure surfaces as a raw
// diesel error. Kept in the `db` layer so `domain::gatekeeper_error` stays diesel-free.
impl From<diesel::result::Error> for GatekeeperError {
    fn from(error: diesel::result::Error) -> Self {
        GatekeeperError::infrastructure("gatekeeper store transaction failed", error)
    }
}

#[cfg(test)]
mod tests {
    use diesel::migration::{Migration, MigrationSource, MigrationVersion};
    use diesel::prelude::*;
    use diesel::sqlite::{Sqlite, SqliteConnection};

    use super::{MIGRATIONS, MIGRATION_NAMESPACE};
    use crate::db::SqliteGatekeeperStore;
    use crate::domain::GatekeeperStore as _;

    #[derive(QueryableByName)]
    struct Name {
        #[diesel(sql_type = diesel::sql_types::Text)]
        name: String,
    }

    /// [`MIGRATIONS`] narrowed to the versions at or below `.0` — it drives a
    /// database to the state an install was in *before* a later migration ran,
    /// so a test can observe what that migration actually changes. Mirrors the
    /// harness of the same name in `apps-rust`'s `db/apps_store.rs`.
    struct MigrationsThrough(&'static str);

    impl MigrationSource<Sqlite> for MigrationsThrough {
        fn migrations(&self) -> diesel::migration::Result<Vec<Box<dyn Migration<Sqlite>>>> {
            let mut migrations = MIGRATIONS.migrations()?;
            let last = MigrationVersion::from(self.0);
            migrations.retain(|m| m.name().version() <= last);
            Ok(migrations)
        }
    }

    /// The regression `0010_ohif_viewer_client_fhir_viewer_redirect` exists for:
    /// migrations are run-once, so an install that already applied `0009` never
    /// re-reads it. Editing `0009`'s `redirect_uris` in place would have left
    /// every upgraded install on the published directory URL, and `/authorize`
    /// matches `redirect_uri` by exact URL equality — so the `/fhir-viewer`
    /// launch would fail there. A fresh open applies both migrations and cannot
    /// tell the two apart; driving a database to `0009` first is the only way to
    /// observe it.
    #[test]
    fn an_install_already_at_0009_is_upgraded_onto_the_fhir_viewer_redirect() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0009"),
        )
        .expect("migrate to 0009");

        let seeded: Vec<Name> =
            diesel::sql_query("SELECT redirect_uris AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("ohif-viewer")
                .load(&mut conn)
                .expect("0009 must have seeded the ohif-viewer client");
        assert_eq!(
            seeded[0].name, r#"["/","https://wildflowerhealth.io/ohif-viewer/"]"#,
            "0009 must stay exactly as it shipped — an install that ran it sees no edit",
        );

        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .expect("upgrade through 0010");

        let upgraded: Vec<Name> =
            diesel::sql_query("SELECT redirect_uris AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("ohif-viewer")
                .load(&mut conn)
                .expect("the client row must survive the upgrade");
        assert_eq!(
            upgraded[0].name,
            r#"["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
        );
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

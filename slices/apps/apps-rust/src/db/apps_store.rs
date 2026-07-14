//! The `SqliteAppsStore` adapter — the `SQLite` implementation of the
//! [`AppsStore`](crate::domain::AppsStore) port. Holds the app-wide r2d2 pool of
//! Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared
//! database file, applies the embedded apps migrations once on construction, and
//! implements the port by delegating to the per-kind query bodies in
//! [`crate::db::app_registration`] / [`crate::db::cloud_apps`] /
//! [`crate::db::self_hosted_apps`] / [`crate::db::all_kinds_apps`]. Mirrors
//! `collector-rust`'s `SqliteRemotesStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::db::{all_kinds_apps, app_registration, cloud_apps, self_hosted_apps};
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration,
    CloudInsertError, SelfHostedAppConfiguration,
};

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`persistence_rust::run_diesel_migrations`], so
/// apps' `0001` and another diesel slice's `0001` never collide.
const MIGRATION_NAMESPACE: &str = "apps";

/// The apps migrations, embedded from the crate's `migrations/` tree at compile
/// time (diesel layout: `<version>_<name>/up.sql` + `down.sql`). Applied once per
/// database in [`SqliteAppsStore::new`] via
/// [`persistence_rust::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`] (see
/// that runner for why the stock diesel harness can't be used across slices).
/// Migration `0001` builds the `app_registrations` table and its three
/// configuration tables; `0002` seeds the default registry (kept separate so the
/// schema and the shipped data version independently). Because each migration runs
/// only once per database, a user-deleted seed stays deleted across upgrades.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`AppsStore`] port — serves the registrations plus
/// the cloud + self-hosted configurations. Cheap to clone (the pool is an `Arc`
/// inside), so it drops straight into the axum state.
#[derive(Clone)]
pub struct SqliteAppsStore {
    // The host-owned app-wide r2d2 pool (`persistence_rust::open_pool`) onto the
    // shared database file. Each query checks a connection out (diesel's API is
    // `&mut`); the pool is an `Arc` inside, so the store is cheap to clone into
    // the axum state. See docs/Persistence/Shared Diesel Pool Explanation.md for
    // how this pool coexists with the rusqlite connection on one file.
    pool: DieselPool,
}

impl SqliteAppsStore {
    /// Wrap the host-owned connection `pool` and apply pending apps migrations
    /// once, on a single checked-out connection. The host builds the app-wide pool
    /// (via `persistence_rust::open_pool`) on the same file its rusqlite
    /// connection opens for the other slices; both coexist (SQLite permits
    /// multiple connections per file).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out or a migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run apps migrations")?;
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .context("failed to apply apps migrations")?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call is
    /// an independent, freshly-migrated database (see
    /// `persistence_rust::open_in_memory_pool`).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(persistence_rust::open_in_memory_pool()?)
    }

    /// Check a connection out of the pool, mapping an exhausted-pool failure to an
    /// opaque [`AppsError::Infrastructure`]. Each per-kind query body runs on one of
    /// these, checked out per call — diesel's connection API is `&mut`, so the store
    /// hands out a fresh connection rather than sharing one.
    fn connection(&self) -> Result<PooledDieselConnection, AppsError> {
        self.pool
            .get()
            .map_err(|e| AppsError::infrastructure("failed to check out a connection", e))
    }

    /// The pool, for tests that tamper with rows via raw SQL.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The `SQLite` implementation of the port: each method checks a connection out
/// of the pool (via [`connection`](Self::connection)) and hands it to the matching
/// per-kind query body ([`crate::db::app_registration`] / [`crate::db::cloud_apps`] /
/// [`crate::db::self_hosted_apps`] / [`crate::db::all_kinds_apps`]). The bodies live
/// there so this file stays the migration + pool handle, and the query SQL stays
/// next to the `table!` + row types it maps. Every method returns the port's PRIMITIVE shape
/// — absence as `None`, delete outcome as `bool`, a cloud insert that wrote nothing
/// as the granular typed [`CloudInsertError`] — leaving the semantic verdicts to
/// [`crate::domain::actions`]. (The self-hosted insert is the exception: it maps its
/// taken-slug / port-exhaustion outcomes onto `AppsError` directly.)
impl AppsStore for SqliteAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        let mut conn = self.connection()?;
        app_registration::list_registrations_on(&mut conn)
    }

    fn find_app(&self, id: &str) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError> {
        let mut conn = self.connection()?;
        all_kinds_apps::find_app_on(&mut conn, id)
    }

    fn list_self_hosted_apps(
        &self,
    ) -> Result<Vec<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
        let mut conn = self.connection()?;
        self_hosted_apps::list_self_hosted_apps_on(&mut conn)
    }

    fn insert_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError> {
        cloud_apps::insert_cloud_app(&mut self.connection()?, registration, config)
    }

    fn insert_self_hosted_app(
        &self,
        registration: &AppRegistration,
        config: &SelfHostedAppConfiguration,
        reserved_ports: &[u16],
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        self_hosted_apps::insert_self_hosted_app(
            &mut self.connection()?,
            registration,
            config,
            reserved_ports,
        )
    }

    fn replace_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError> {
        cloud_apps::replace_cloud_app(&mut self.connection()?, registration, config)
    }

    fn replace_self_hosted_app(
        &self,
        registration: &AppRegistration,
        config: &SelfHostedAppConfiguration,
    ) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
        self_hosted_apps::replace_self_hosted_app(&mut self.connection()?, registration, config)
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
        all_kinds_apps::delete_app(&mut self.connection()?, id)
    }

    fn replace_placements(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppsError> {
        app_registration::replace_placements(&mut self.connection()?, entries)
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::db::app_registration::app_registrations;

    /// Running the migrations twice is a no-op the second time (the namespaced
    /// runner skips the already-applied `0001`), and the seeded default registry
    /// lands exactly once — so opening an existing database never re-seeds or
    /// errors.
    #[test]
    fn migrations_are_idempotent_and_seed_the_default_registry_once() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .unwrap();
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .unwrap();
        let row_count: i64 = app_registrations::table
            .count()
            .get_result(&mut conn)
            .expect("app_registrations must exist after migrate");
        assert_eq!(row_count, 6, "exactly the six seeded default apps");
    }

    /// The `app_registrations` primary key gives global id uniqueness across kinds
    /// — a second registration with a seeded id is rejected by the PK, so no two
    /// apps (of any kind) can share an id.
    #[test]
    fn app_registrations_id_is_globally_unique() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        let dup = diesel::insert_into(app_registrations::table)
            .values((
                app_registrations::id.eq("api-docs"),
                app_registrations::kind.eq("cloud"),
                app_registrations::position.eq(99_i64),
                app_registrations::on_homescreen.eq(true),
                app_registrations::name.eq("Dup"),
                app_registrations::local_only.eq(false),
                app_registrations::requires_tunnel.eq(false),
            ))
            .execute(&mut conn);
        assert!(
            dup.is_err(),
            "duplicate app_registrations id must violate the PK"
        );
    }

    /// The port hands back the seeded registry, in display order.
    #[test]
    fn list_registrations_returns_the_seeded_registry_in_order() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let ids: Vec<String> = store
            .list_registrations()
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(
            ids,
            vec![
                "patient-browser",
                "api-view",
                "api-docs",
                "growth-chart",
                "medication-viewer",
                "precise-hbr",
            ],
        );
    }
}

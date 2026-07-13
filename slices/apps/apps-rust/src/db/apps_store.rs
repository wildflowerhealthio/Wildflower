//! The `SqliteAppsStore` adapter — the `SQLite` implementation of the
//! [`AppsStore`](crate::domain::AppsStore) port. Holds the app-wide r2d2 pool of
//! Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared
//! database file, applies the embedded apps migrations once on construction, and
//! implements the port by delegating to the per-concern query bodies in
//! [`crate::db::reads`] / [`crate::db::writes`]. Mirrors `collector-rust`'s
//! `SqliteRemotesStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::db::{reads, writes};
use crate::domain::{
    App, AppError, AppsStore, CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError,
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
/// Migration `0001` builds the concrete tables, the `home_screen` ordering table,
/// and the `apps_view`, and seeds the default registry; because each migration
/// runs only once per database, a user-deleted seed stays deleted across upgrades.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`AppsStore`] port — serves the parent registry
/// plus the cloud + self-hosted children. Cheap to clone (the pool is an `Arc`
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
    /// opaque [`AppError::Infrastructure`]. Each query body in [`crate::db::reads`]
    /// / [`crate::db::writes`] runs on one of these, checked out per call —
    /// diesel's connection API is `&mut`, so the store hands out a fresh
    /// connection rather than sharing one.
    fn connection(&self) -> Result<PooledDieselConnection, AppError> {
        self.pool
            .get()
            .map_err(|e| AppError::infrastructure("failed to check out a connection", e))
    }

    /// The pool, for tests that tamper with rows via raw SQL.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The `SQLite` implementation of the port: each method checks a connection out
/// of the pool (via [`connection`](Self::connection)) and hands it to the matching
/// query body in [`crate::db::reads`] / [`crate::db::writes`]. The bodies live
/// there so this file stays the migration + pool handle, and the query SQL stays
/// next to the row types it maps. Every method returns the port's PRIMITIVE shape
/// — absence as `None`, delete outcome as `bool`, an upload allocation failure as
/// [`UploadInsertError`] — leaving the semantic verdicts to
/// [`crate::domain::actions`].
impl AppsStore for SqliteAppsStore {
    fn list_apps(&self) -> Result<Vec<App>, AppError> {
        let mut conn = self.connection()?;
        reads::list_apps_on(&mut conn)
    }

    fn find_app(&self, id: &str) -> Result<Option<App>, AppError> {
        let mut conn = self.connection()?;
        reads::find_app_on(&mut conn, id)
    }

    fn list_self_hosted_apps(&self) -> Result<Vec<App>, AppError> {
        let mut conn = self.connection()?;
        reads::list_self_hosted_apps_on(&mut conn)
    }

    fn insert_cloud_app(&self, new: &NewCloudApp) -> Result<Option<App>, AppError> {
        writes::insert_cloud_app(&mut self.connection()?, new)
    }

    fn insert_self_hosted_app(
        &self,
        new: &NewSelfHostedUpload,
    ) -> Result<Result<App, UploadInsertError>, AppError> {
        writes::insert_self_hosted_app(&mut self.connection()?, new)
    }

    fn replace_cloud_content(
        &self,
        id: &str,
        content: &CloudContent,
    ) -> Result<Option<App>, AppError> {
        writes::replace_cloud_content(&mut self.connection()?, id, content)
    }

    fn replace_self_hosted_launch_path(
        &self,
        id: &str,
        launch_path: Option<&str>,
    ) -> Result<Option<App>, AppError> {
        writes::replace_self_hosted_launch_path(&mut self.connection()?, id, launch_path)
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppError> {
        writes::delete_app(&mut self.connection()?, id)
    }

    fn replace_home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<App>>, AppError> {
        writes::replace_home_screen(&mut self.connection()?, entries)
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::db::schema::home_screen;
    use crate::domain::App;

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
        let row_count: i64 = home_screen::table
            .count()
            .get_result(&mut conn)
            .expect("home_screen must exist after migrate");
        assert_eq!(row_count, 6, "exactly the six seeded default apps");
    }

    /// The `home_screen` primary key gives global id uniqueness across kinds — a
    /// second `home_screen` row with a seeded id is rejected by the PK, so no two
    /// apps (of any kind) can share an id.
    #[test]
    fn home_screen_id_is_globally_unique() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        let dup = diesel::insert_into(home_screen::table)
            .values((
                home_screen::app_id.eq("api-docs"),
                home_screen::position.eq(99_i64),
                home_screen::enabled.eq(true),
            ))
            .execute(&mut conn);
        assert!(
            dup.is_err(),
            "duplicate home_screen app_id must violate the PK"
        );
    }

    /// The port hands back whole [`App`]s from a fresh install — the seeded
    /// registry, in display order.
    #[test]
    fn list_apps_returns_the_seeded_registry_in_order() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let ids: Vec<String> = store
            .list_apps()
            .unwrap()
            .iter()
            .map(|a: &App| a.id().to_owned())
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

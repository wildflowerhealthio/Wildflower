//! `SQLite` persistence for the apps slice — the [`AppsStore`] over the app-wide
//! r2d2 pool of diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto
//! the shared database file, mirroring collector's `RemotesStore`. Table-per-
//! struct: standalone `cloud_apps` and `self_hosted_apps`, plus a `home_screen`
//! table for the cross-kind ordering + enabled flag; system apps have no table.
//!
//! [`AppsStore::new`] applies the embedded migrations once on a pooled connection
//! (diesel records applied versions in its own `__diesel_schema_migrations`
//! table, disjoint from collector's `0001`/`0002` since this slice uses
//! date-stamped versions — the two diesel slices coexist in the shared database
//! with no version collision). The modules split by concern:
//!
//!  - this module — the handle itself;
//!  - [`schema`] — the diesel `table!` definitions;
//!  - [`columns`] — the diesel column newtypes for `AppUrl` (TEXT) and `port`
//!    (INTEGER → `u16`);
//!  - [`reads`] — the cross-kind `apps_view` decode ([`App`](crate::domain::App))
//!    and every read over it (`list_apps`, `find_app`, `list_self_hosted_apps`);
//!  - [`writes`] — the per-kind mutators (each a single-kind write to a concrete
//!    table plus its `home_screen` row), returning the hydrated app re-read.
//!
//! For the provenance taxonomy these tables encode, see
//! `docs/Apps/Explanation.md`.

pub(crate) mod columns;
mod reads;
pub(crate) mod schema;
mod write_inputs;
mod writes;

pub use write_inputs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};

use anyhow::Context;
use diesel::r2d2::{ConnectionManager, PooledConnection};
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use persistence_rust::DieselPool;

use crate::domain::AppError;

/// The apps migrations, embedded from the crate's `migrations/` tree at compile
/// time (diesel layout: `<version>_<name>/up.sql` + `down.sql`). Applied once per
/// database in [`AppsStore::new`]. The single date-stamped version is destructive
/// (drop + recreate + reseed away from the former class-table-inheritance
/// layout); because each migration runs only once per database, a user-deleted
/// seed stays deleted across upgrades.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// A connection checked out of the pool for one operation.
pub(crate) type PooledConn = PooledConnection<ConnectionManager<SqliteConnection>>;

/// The apps-slice store handle — holds the app-wide r2d2 pool onto the shared
/// database file and applies the embedded migrations once on construction. Cheap
/// to clone into the axum state (the pool is an `Arc` inside).
#[derive(Clone)]
pub struct AppsStore {
    pool: DieselPool,
}

impl AppsStore {
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
        conn.run_pending_migrations(MIGRATIONS)
            .map_err(|e| anyhow::anyhow!("failed to apply apps migrations: {e}"))?;
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
    /// opaque [`AppError::Backend`].
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] when no connection can be checked out.
    pub(crate) fn checkout(&self) -> Result<PooledConn, AppError> {
        self.pool
            .get()
            .map_err(|e| AppError::backend("failed to check out a connection", e))
    }

    /// The pool, for tests that tamper with rows via raw SQL.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::schema::home_screen;
    use super::AppsStore;

    /// The `home_screen` primary key gives global id uniqueness across kinds — a
    /// second `home_screen` row with a seeded id is rejected by the PK, so no two
    /// apps (of any kind) can share an id.
    #[test]
    fn home_screen_id_is_globally_unique() {
        let store = AppsStore::open_in_memory().unwrap();
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
}

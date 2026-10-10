//! The `SqliteRequestLogStore` adapter — the `SQLite` implementation of the
//! [`RequestLogStore`](crate::domain::RequestLogStore) port. Holds the app-wide
//! r2d2 pool of Diesel `SqliteConnection`s (`wildflowerhealthio_persistence::DieselPool`) onto
//! the shared database file, applies the embedded request-log migrations once
//! on construction, and implements the port by delegating to the query bodies
//! in [`crate::db::logged_requests`]. Mirrors `collector-rust`'s
//! `SqliteRemotesStore`.

use anyhow::Context;
use chrono::{DateTime, Utc};
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use wildflowerhealthio_persistence::{DieselPool, PooledDieselConnection};
use wildflowerhealthio_shared_structures::request_caller::ForwardedRequest;

use crate::db::logged_requests;
use crate::domain::request_log::{CallerSummary, RequestLogFilter, RequestLogPage};
use crate::domain::{CallerClass, RequestLogError, RequestLogStore};

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`wildflowerhealthio_persistence::run_diesel_migrations`], so
/// the request log's `0001` and another diesel slice's `0001` never collide.
const MIGRATION_NAMESPACE: &str = "request-log";

/// The request-log migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteRequestLogStore::new`] via
/// [`wildflowerhealthio_persistence::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`]
/// (see that runner for why the stock diesel harness can't be used).
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`RequestLogStore`] port. Cheap to clone (the
/// pool is an `Arc` inside), so it drops straight into the axum state and the
/// writer and sweep tasks.
#[derive(Clone)]
pub struct SqliteRequestLogStore {
    // The host-owned app-wide r2d2 pool (`wildflowerhealthio_persistence::open_pool`) onto the
    // shared database file. Each query checks a connection out (diesel's API is
    // `&mut`). See docs/Persistence/Shared Diesel Pool Explanation.md for how
    // this pool coexists with the rusqlite connection on one file.
    pool: DieselPool,
}

impl SqliteRequestLogStore {
    /// Wrap the host-owned connection `pool` and apply pending request-log
    /// migrations once, on a single checked-out connection.
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run request-log migrations")?;
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .context("failed to apply request-log migrations")?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call is
    /// an independent, freshly-migrated database. Uses
    /// `wildflowerhealthio_persistence::open_in_memory_pool`, whose shared-cache URI keeps the
    /// pooled connections on one in-memory database (a naive `:memory:` pool
    /// gives each connection its own empty db).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(wildflowerhealthio_persistence::open_in_memory_pool()?)
    }

    /// Check out a connection from the pool.
    pub(super) fn connection(&self) -> Result<PooledDieselConnection, RequestLogError> {
        self.pool
            .get()
            .map_err(|e| RequestLogError::infrastructure("failed to check out a connection", e))
    }
}

/// The `SQLite` implementation of the port: each method is a thin delegation to
/// the query body in [`crate::db::logged_requests`], handing it a checked-out
/// connection from the pool.
impl RequestLogStore for SqliteRequestLogStore {
    fn insert_requests(&self, requests: &[ForwardedRequest]) -> Result<(), RequestLogError> {
        logged_requests::insert_requests(&mut self.connection()?, requests)
    }

    fn delete_requests_beyond_cap(
        &self,
        caller_class: CallerClass,
        row_cap: i64,
    ) -> Result<usize, RequestLogError> {
        logged_requests::delete_requests_beyond_cap(&mut self.connection()?, caller_class, row_cap)
    }

    fn delete_requests_received_before(
        &self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, RequestLogError> {
        logged_requests::delete_requests_received_before(&mut self.connection()?, cutoff)
    }

    fn requests_page(&self, filter: &RequestLogFilter) -> Result<RequestLogPage, RequestLogError> {
        logged_requests::requests_page(&mut self.connection()?, filter)
    }

    fn caller_summaries(&self) -> Result<Vec<CallerSummary>, RequestLogError> {
        logged_requests::caller_summaries(&mut self.connection()?)
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::db::schema::logged_requests;

    /// Running the migrations twice is a no-op the second time (the namespaced
    /// runner skips already-applied versions) and leaves the empty table, so
    /// opening an existing database never errors.
    #[test]
    fn migrations_are_idempotent_and_create_the_log() {
        let pool = wildflowerhealthio_persistence::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .unwrap();
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .unwrap();
        let row_count: i64 = logged_requests::table
            .count()
            .get_result(&mut conn)
            .expect("logged_requests must exist after migrate");
        assert_eq!(row_count, 0);
    }
}

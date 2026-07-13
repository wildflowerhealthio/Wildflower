//! An app-wide diesel r2d2 connection pool onto the shared database file — the
//! diesel counterpart of this crate's rusqlite [`Connection`](crate::Connection).
//!
//! The Tauri app opens one shared rusqlite [`Connection`](crate::Connection) and
//! builds one [`DieselPool`] on the SAME database file, then hands the pool to
//! every diesel-backed slice (today just the collector; more slices are moving
//! to diesel). The pool's connections are additional openers onto that one file
//! — SQLite permits multiple connections per file — and the per-connection
//! pragmas below mirror [`Connection::configured`](crate::Connection) so a
//! diesel connection behaves identically to the rusqlite one under contention.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::Context;
use diesel::connection::SimpleConnection;
use diesel::r2d2::{self, ConnectionManager, CustomizeConnection, Pool};
use diesel::sqlite::SqliteConnection;

/// The app-wide r2d2 pool of diesel `SqliteConnection`s. `Clone` (it wraps an
/// `Arc`), so it's cheap to hand into each slice's state.
pub type DieselPool = Pool<ConnectionManager<SqliteConnection>>;

/// A connection checked out of a [`DieselPool`]. Diesel's connection API is
/// `&mut`, so a slice's query bodies each take one of these (checked out by the
/// store) rather than sharing a single connection behind a mutex.
pub type PooledDieselConnection = r2d2::PooledConnection<ConnectionManager<SqliteConnection>>;

/// A deliberately small pool cap. This is a single-user desktop app, and WAL is
/// deliberately OFF repo-wide (see [`Connection`](crate::Connection)), so SQLite
/// permits only ONE writer at a time across ALL connections to the file — the
/// pool buys concurrent *reads*, never concurrent writes. A handful of readers
/// (a slice's list/get racing a write on another connection) is the whole
/// workload, so 4 is ample headroom without holding a pile of idle file handles
/// open.
const MAX_POOL_SIZE: u32 = 4;

/// Applies the per-connection runtime settings to every connection r2d2
/// establishes. These pragmas are per-connection state in SQLite — they don't
/// persist in the database file — so each pooled connection must set them
/// itself, exactly as [`Connection::configured`](crate::Connection) does for the
/// rusqlite connection. Keeping the two openers' pragmas identical means either
/// connection behaves the same under contention.
#[derive(Debug)]
struct PragmaCustomizer;

impl CustomizeConnection<SqliteConnection, r2d2::Error> for PragmaCustomizer {
    fn on_acquire(&self, conn: &mut SqliteConnection) -> Result<(), r2d2::Error> {
        // - `busy_timeout` (5s, matching this crate's `BUSY_TIMEOUT`) so a write
        //   rides out brief contention — from the rusqlite connection or another
        //   pooled connection — instead of failing instantly with `SQLITE_BUSY`.
        // - `foreign_keys = ON`, which SQLite defaults OFF per connection — set
        //   outside any transaction.
        conn.batch_execute("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
            .map_err(r2d2::Error::QueryError)
    }
}

/// Build the app-wide diesel connection pool onto the shared database at
/// `db_path`. The host calls this next to [`Connection::open`](crate::Connection)
/// on the same path and shares the pool with every diesel-backed slice.
///
/// # Errors
///
/// Returns an error if the parent directory can't be created, the path isn't
/// valid UTF-8, or the pool can't establish its initial connections.
pub fn open_pool(db_path: &Path) -> anyhow::Result<DieselPool> {
    // Be robust if a slice opens the file before the host has: create the parent
    // dir the same way `Connection::open` does.
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create db dir {}", parent.display()))?;
    }
    let database_url = db_path
        .to_str()
        .with_context(|| format!("db path {} is not valid UTF-8", db_path.display()))?;
    build_pool(database_url, MAX_POOL_SIZE)
}

/// Build a diesel pool over a private in-memory database — the diesel
/// counterpart of [`Connection::open_in_memory`](crate::Connection), for slice
/// tests. Each call is an independent, empty database.
///
/// A naive pool over `:memory:` would give each pooled connection its OWN empty
/// database, so a migration on one connection would be invisible to the next
/// checkout. This uses a shared-cache URI (`file:<name>?mode=memory&cache=shared`)
/// with a process-unique `<name>`, so every connection the pool opens shares one
/// in-memory database while staying isolated from other callers. diesel's
/// `SqliteConnection::establish` accepts `file:` URIs as-is (libsqlite3-sys opens
/// with `SQLITE_OPEN_URI`), so no extra flags are needed.
///
/// Lifetime subtlety: a shared-cache in-memory database lives only while at
/// least one connection to it is open. r2d2 defaults `min_idle` to `max_size`
/// and establishes them eagerly at `build`, so the pool keeps connections
/// resident for its lifetime and the database survives between checkouts.
///
/// # Errors
///
/// Returns an error if the pool can't establish its initial connections.
pub fn open_in_memory_pool() -> anyhow::Result<DieselPool> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = COUNTER.fetch_add(1, Ordering::Relaxed);
    let url = format!("file:persistence-diesel-mem-{name}?mode=memory&cache=shared");
    build_pool(&url, MAX_POOL_SIZE)
}

/// Shared pool builder over a diesel database URL. Split out so the file and
/// in-memory constructors, and tests, can point it at a bespoke URL and size.
fn build_pool(database_url: &str, max_size: u32) -> anyhow::Result<DieselPool> {
    Pool::builder()
        .max_size(max_size)
        // Fail an exhausted-pool checkout fast rather than blocking the async
        // worker for r2d2's 30 s default: every store method calls the
        // synchronous `pool.get()` inside an axum handler, so a stuck checkout
        // pins a tokio worker. 5 s matches the single-writer `busy_timeout`, so
        // a checkout only outlives the contention it's waiting on by a hair.
        .connection_timeout(std::time::Duration::from_secs(5))
        .connection_customizer(Box::new(PragmaCustomizer))
        .build(ConnectionManager::<SqliteConnection>::new(database_url))
        .with_context(|| format!("failed to build diesel connection pool for {database_url}"))
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;
    use diesel::sql_types::BigInt;

    use super::*;

    #[derive(QueryableByName)]
    struct Scalar {
        #[diesel(sql_type = BigInt)]
        value: i64,
    }

    fn scalar(conn: &mut SqliteConnection, sql: &str) -> i64 {
        diesel::sql_query(sql)
            .load::<Scalar>(conn)
            .expect("scalar query")
            .first()
            .expect("one row")
            .value
    }

    /// Every checked-out connection has the pragmas the customizer applies —
    /// `busy_timeout = 5000` and `foreign_keys = ON` — so it matches the
    /// rusqlite `Connection`'s configuration.
    #[test]
    fn applies_pragmas_on_acquire() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_pool(&dir.path().join("pragmas.db")).expect("open pool");
        let mut conn = pool.get().expect("check out a connection");
        assert_eq!(
            scalar(
                &mut conn,
                "SELECT timeout AS value FROM pragma_busy_timeout()"
            ),
            5000,
        );
        assert_eq!(
            scalar(
                &mut conn,
                "SELECT foreign_keys AS value FROM pragma_foreign_keys()",
            ),
            1,
        );
    }

    /// Rows written on one pooled connection are visible on a separately
    /// checked-out one — the pool's connections all open the same file (and
    /// `open_pool` created the missing parent directory).
    #[test]
    fn pooled_connections_share_the_database_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("nested").join("shared.db");
        let pool = open_pool(&db_path).expect("open pool");
        assert!(
            db_path.parent().expect("has parent").exists(),
            "open_pool creates the parent dir",
        );

        {
            let mut writer = pool.get().expect("check out writer");
            writer
                .batch_execute(
                    "CREATE TABLE t (id INTEGER PRIMARY KEY);\
                     INSERT INTO t (id) VALUES (1), (2), (3);",
                )
                .expect("seed rows");
        }

        let mut reader = pool.get().expect("check out reader");
        assert_eq!(scalar(&mut reader, "SELECT COUNT(*) AS value FROM t"), 3);
    }

    /// The in-memory pool is a shared-cache database: a table created on one
    /// checkout is visible on another, and each call is an independent database
    /// so tests don't leak into each other.
    #[test]
    fn in_memory_pool_shares_one_database_across_checkouts() {
        let pool = open_in_memory_pool().expect("open in-memory pool");
        {
            let mut writer = pool.get().expect("check out writer");
            writer
                .batch_execute("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);")
                .expect("seed");
        }
        let mut reader = pool.get().expect("check out reader");
        assert_eq!(scalar(&mut reader, "SELECT COUNT(*) AS value FROM t"), 1);

        // A fresh in-memory pool is an independent, empty database — no `t`.
        let other = open_in_memory_pool().expect("open another in-memory pool");
        let mut conn = other.get().expect("check out");
        assert_eq!(
            scalar(
                &mut conn,
                "SELECT COUNT(*) AS value FROM sqlite_master WHERE name = 't'",
            ),
            0,
        );
    }
}

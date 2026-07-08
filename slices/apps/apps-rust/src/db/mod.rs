//! `SQLite` persistence for the apps slice: a parent `apps` registry plus
//! per-kind child tables (`cloud_apps`, `self_hosted_apps`), served by **one
//! store** speaking whole [`App`](crate::domain::App)s.
//!
//! [`AppsStore`] wraps the shared connection and owns the migration list (so
//! constructing it migrates every table). The modules split by concern:
//!
//!  - this module — the handle, the migrations, and the rusqlite
//!    `ToSql`/`FromSql` glue for the two column newtypes
//!    ([`Provenance`] and [`AppUrl`]);
//!  - [`reads`] — the single JOIN projection decoding an [`App`](crate::domain::App)
//!    (parent row + kind payload) and every read over it (`list_apps`,
//!    `find_app`, `list_self_hosted_apps`);
//!  - [`writes`] — the spec-typed mutators, each one transaction over parent +
//!    child, returning the hydrated app re-read in-txn.
//!
//! For the provenance taxonomy these tables encode, see
//! `docs/Apps/Explanation.md`.

mod reads;
mod writes;

use anyhow::Context;
use persistence_rust::Connection;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::ToSql;

use crate::domain::{AppUrl, Provenance};

/// The apps-slice store handle — wraps the shared SQLite connection and applies
/// the per-namespace migrations onto it.
#[derive(Clone)]
pub struct AppsStore {
    conn: Connection,
}

impl AppsStore {
    /// Wrap the shared `conn` and apply pending apps migrations onto it.
    /// The connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the apps migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply apps migrations")?;
        }
        Ok(Self { conn })
    }

    /// Open a private in-memory shared connection and wrap it — for tests.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(Connection::open_in_memory().context("failed to open in-memory sqlite")?)
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}

impl ToSql for Provenance {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        // The kebab discriminant the `CHECK (provenance IN (...))` constraint
        // matches; the one `str::parse` round-trips.
        Ok(ToSqlOutput::Owned(Value::Text(self.as_str().to_owned())))
    }
}

impl FromSql for Provenance {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        // An unknown discriminant (a tampered row) surfaces as a typed read
        // error rather than a panic.
        s.parse::<Provenance>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for AppUrl {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        // The canonical string (see `AppUrl`'s `Display`) — the only form the
        // `url` column ever holds, and the one `str::parse` round-trips.
        Ok(ToSqlOutput::Owned(Value::Text(self.to_string())))
    }
}

impl FromSql for AppUrl {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        // A stored URL that no longer parses (e.g. an externally tampered row)
        // surfaces as a typed read error rather than a silent unsafe redirect.
        s.parse::<AppUrl>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

/// Migration namespace for the apps tables in the shared database.
const NAMESPACE: &str = "apps";

/// Apply pending apps migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `apps` namespace, so
/// they coexist with other slices in one shared database.
fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. The 4th entry (`004_apps_registry.sql`) replaces the
/// two flat tables with the parent registry + per-kind child tables and seeds
/// the full default set; the 5th (`005_self_hosted_seeded.sql`) adds the
/// `seeded` flag distinguishing migration-seeded self-hosted rows from uploaded
/// ones; the 6th (`006_self_hosted_launch_path.sql`) adds the nullable
/// `launch_path` inferred at install for bundles that ship a `launch.html`.
/// Because each migration runs only once per database, a user-deleted seeded
/// row stays deleted across upgrades — only fresh installs see the full default
/// set.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_internal_apps_table.sql"),
    include_str!("../migrations/003_seed_precise_hbr.sql"),
    include_str!("../migrations/004_apps_registry.sql"),
    include_str!("../migrations/005_self_hosted_seeded.sql"),
    include_str!("../migrations/006_self_hosted_launch_path.sql"),
];

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;

    #[test]
    fn migrate_is_idempotent_and_creates_the_registry_tables() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        for table in ["apps", "cloud_apps", "self_hosted_apps"] {
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            assert!(exists, "{table} table must exist after migrate");
        }
    }

    /// The parent primary key gives global id uniqueness across kinds — a second
    /// parent row with a seeded id is rejected by the PK.
    #[test]
    fn parent_id_is_globally_unique() {
        let store = AppsStore::open_in_memory().unwrap();
        let dup = store.conn().lock().execute(
            "INSERT INTO apps (id, name, enabled, position, provenance, local_only) \
             VALUES ('api-docs', 'dup', 1, 99, 'cloud', 0)",
            [],
        );
        assert!(dup.is_err(), "duplicate parent id must violate the PK");
    }
}

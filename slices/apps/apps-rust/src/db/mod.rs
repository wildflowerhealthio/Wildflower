//! `SQLite` persistence for the apps slice: a parent `apps` registry plus
//! per-kind child tables (`cloud_apps`, `self_hosted_apps`), served by **one
//! store** speaking whole [`App`](crate::domain::App)s.
//!
//! [`AppsStore`] wraps the shared connection and runs the [`migrations`] on
//! construction (so constructing it migrates every table). The modules split by
//! concern:
//!
//!  - this module — the handle itself;
//!  - [`columns`] — the rusqlite `ToSql`/`FromSql` glue for the two column
//!    newtypes ([`Provenance`](crate::domain::Provenance) and
//!    [`AppUrl`](crate::domain::AppUrl));
//!  - [`migrations`] — the ordered migration list and the namespaced runner;
//!  - [`reads`] — the single JOIN projection decoding an [`App`](crate::domain::App)
//!    (parent row + kind payload) and every read over it (`list_apps`,
//!    `find_app`, `list_self_hosted_apps`);
//!  - [`writes`] — the spec-typed mutators, each one transaction over parent +
//!    child, returning the hydrated app re-read in-txn.
//!
//! For the provenance taxonomy these tables encode, see
//! `docs/Apps/Explanation.md`.

mod columns;
mod migrations;
mod reads;
mod write_inputs;
mod writes;

pub use write_inputs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};

use anyhow::Context;
use persistence_rust::Connection;

use self::migrations::migrate;

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

#[cfg(test)]
mod tests {
    use super::*;

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

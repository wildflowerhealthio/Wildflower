//! The `InternalAppsStore` handle — reads the static internal-apps catalogue
//! from the shared connection. Internal apps are seeded by migration and
//! are not editable through the admin API; the store exposes only read
//! methods. Migrations are run by [`AppsStore`](super::AppsStore), which
//! owns the shared migration list — `InternalAppsStore::new` is a thin
//! wrapper that assumes the tables already exist.

use persistence_rust::{sql_row, Connection, DbResult};
use rusqlite::{params, OptionalExtension};

use crate::domain::InternalApp;

/// Read-only handle over the `internal_apps` table. Migrations are owned
/// by [`AppsStore`](super::AppsStore); construct that first to ensure the
/// table exists before reading from this store.
#[derive(Clone)]
pub struct InternalAppsStore {
    conn: Connection,
}

impl InternalAppsStore {
    /// Wrap the shared `conn` for reads. Assumes the apps migrations have
    /// already been applied (via [`AppsStore::new`](super::AppsStore::new)).
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    /// All internal-app rows, in seed/insertion order. Used by `GET /apps`
    /// to merge the internal catalogue into the wire response.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list(&self) -> DbResult<Vec<InternalApp>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare(&format!("SELECT {ALL_COLS} FROM internal_apps ORDER BY rowid"))?;
        let rows = stmt.query_map([], |row| InternalApp::try_from(row))?;
        rows.collect()
    }

    /// Single row by id, `None` when absent. Used by `POST /apps/{id}` to
    /// dispatch a launch to the internal path before falling through to
    /// the externals store.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find(&self, id: &str) -> DbResult<Option<InternalApp>> {
        self.conn
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM internal_apps WHERE id = ?1"),
                params![id],
                |row| InternalApp::try_from(row),
            )
            .optional()
    }
}

// Field names match the SQL column names; the macro derives `TryFrom<&Row>`
// and `ALL_COLS` off the field list.
sql_row!(InternalApp {
    id,
    enabled,
    name,
    subtitle,
    port,
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::AppsStore;

    /// The store hands back the seeded row with its port intact. (The
    /// seed migration also strips the matching externals row — see
    /// [`AppsStore`]'s migration tests.)
    #[test]
    fn list_returns_the_seeded_patient_browser_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let internals = InternalAppsStore::new(store.conn().clone());
        let rows = internals.list().unwrap();
        let pb = rows
            .iter()
            .find(|r| r.id == "patient-browser")
            .expect("patient-browser is seeded");
        assert!(pb.enabled);
        assert_eq!(pb.name, "Patient Browser");
        assert_eq!(pb.port, 8081);
    }

    #[test]
    fn find_returns_some_for_a_seeded_id_and_none_otherwise() {
        let store = AppsStore::open_in_memory().unwrap();
        let internals = InternalAppsStore::new(store.conn().clone());
        assert!(internals.find("patient-browser").unwrap().is_some());
        assert!(internals.find("no-such-id").unwrap().is_none());
    }
}

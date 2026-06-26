//! Read-only row mapping + queries for the static `internal_apps` catalogue
//! (seeded by migration, not editable through the admin API). A second
//! `impl AppsStore` block rather than a separate store — its own module only
//! because the `sql_row!`-generated `ALL_COLS` would otherwise collide with the
//! `apps` table's in `apps_store.rs`. See [`crate::db`].

use persistence_rust::{sql_row, DbResult};
use rusqlite::{params, OptionalExtension};

use super::AppsStore;
use crate::domain::InternalApp;

impl AppsStore {
    /// All internal-app rows, in seed/insertion order. Backs `GET /apps`'s merge
    /// of the internal catalogue into the wire response.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_internal_apps(&self) -> DbResult<Vec<InternalApp>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ALL_COLS} FROM internal_apps ORDER BY rowid"
        ))?;
        let rows = stmt.query_map([], |row| InternalApp::try_from(row))?;
        rows.collect()
    }

    /// Single internal-app row by id, `None` when absent. Backs `POST /apps/{id}`'s
    /// internal-first launch dispatch.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_internal_app(&self, id: &str) -> DbResult<Option<InternalApp>> {
        self.conn()
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
    use crate::db::AppsStore;

    /// The store hands back the seeded row with its port intact. (The seed
    /// migration also strips the matching externals row — see [`AppsStore`]'s
    /// migration tests.)
    #[test]
    fn list_returns_the_seeded_patient_browser_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let rows = store.list_internal_apps().unwrap();
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
        assert!(store
            .find_internal_app("patient-browser")
            .unwrap()
            .is_some());
        assert!(store.find_internal_app("no-such-id").unwrap().is_none());
    }
}

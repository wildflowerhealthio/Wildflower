//! Row mapping + read queries for the static `internal_apps` catalogue.
//!
//! Internal apps are seeded by migration and not editable through the admin
//! API, so this is read-only. There is **no separate store struct** — the whole
//! apps slice is served by [`AppsStore`](super::AppsStore), which exposes
//! [`list_internal_apps`](super::AppsStore::list_internal_apps) /
//! [`find_internal_app`](super::AppsStore::find_internal_app) that delegate to
//! the free functions here. They live in their own module only because the
//! `sql_row!`-generated `ALL_COLS` is module-scoped and would collide with the
//! `apps` table's in `apps_store.rs`.

use persistence_rust::{sql_row, Connection, DbResult};
use rusqlite::{params, OptionalExtension};

use crate::domain::InternalApp;

/// All internal-app rows, in seed/insertion order. Backs `GET /apps`'s merge of
/// the internal catalogue into the wire response.
pub(super) fn list_internal_apps(conn: &Connection) -> DbResult<Vec<InternalApp>> {
    let conn = conn.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {ALL_COLS} FROM internal_apps ORDER BY rowid"
    ))?;
    let rows = stmt.query_map([], |row| InternalApp::try_from(row))?;
    rows.collect()
}

/// Single internal-app row by id, `None` when absent. Backs `POST /apps/{id}`'s
/// internal-first launch dispatch.
pub(super) fn find_internal_app(conn: &Connection, id: &str) -> DbResult<Option<InternalApp>> {
    conn.lock()
        .query_row(
            &format!("SELECT {ALL_COLS} FROM internal_apps WHERE id = ?1"),
            params![id],
            |row| InternalApp::try_from(row),
        )
        .optional()
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
        assert!(store.find_internal_app("patient-browser").unwrap().is_some());
        assert!(store.find_internal_app("no-such-id").unwrap().is_none());
    }
}

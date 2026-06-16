//! Row mapping + read queries for the `apps` table. One row per app id; the
//! `kind` column tells the wire layer whether `custom_*` is meaningful.

use rusqlite::Row;

use crate::db::AppsStore;
use persistence_rust::DbResult;

/// The full column list, shared by every read.
const COLS: &str = "id, kind, enabled, custom_name, custom_url, custom_requires_tunnel";

/// One row of the `apps` table — the persisted shape, before the registry
/// metadata for bundled rows is layered on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRow {
    pub id: String,
    /// One of `bundled` / `action` / `custom`. Kept as a `String` (not an
    /// enum) so a row mapping is the column read and nothing more; the wire
    /// layer projects to [`crate::domain::AppKind`].
    pub kind: String,
    pub enabled: bool,
    pub custom_name: Option<String>,
    pub custom_url: Option<String>,
    pub custom_requires_tunnel: Option<bool>,
}

impl TryFrom<&Row<'_>> for AppRow {
    type Error = rusqlite::Error;

    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AppRow {
            id: row.get("id")?,
            kind: row.get("kind")?,
            enabled: row.get("enabled")?,
            custom_name: row.get("custom_name")?,
            custom_url: row.get("custom_url")?,
            custom_requires_tunnel: row.get("custom_requires_tunnel")?,
        })
    }
}

impl AppsStore {
    /// All rows, in seed/insertion order. Used by `GET /apps` to build the
    /// catalogue.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_apps(&self) -> DbResult<Vec<AppRow>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM apps ORDER BY rowid"))?;
        let rows = stmt.query_map([], |row| AppRow::try_from(row))?;
        rows.collect()
    }

    /// Single row by id, `None` when absent.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_app(&self, id: &str) -> DbResult<Option<AppRow>> {
        let conn = self.conn().lock();
        conn.query_row(
            &format!("SELECT {COLS} FROM apps WHERE id = ?1"),
            [id],
            |row| AppRow::try_from(row),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_apps_returns_seeded_bundled_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        let rows = store.list_apps().unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        for app in crate::domain::BUNDLED_APPS {
            assert!(
                ids.contains(&app.id),
                "seeded list missing {} — got {:?}",
                app.id,
                ids,
            );
        }
        // Every seeded row is bundled/action with no custom_* fields.
        for row in &rows {
            assert!(
                row.custom_name.is_none()
                    && row.custom_url.is_none()
                    && row.custom_requires_tunnel.is_none(),
                "bundled row has custom_* set: {row:?}",
            );
        }
    }

    #[test]
    fn find_app_returns_none_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let found = store.find_app("no-such-app").unwrap();
        assert!(found.is_none());
    }
}

//! The `AppsStore` handle — wraps the shared SQLite connection, applies the
//! per-namespace migrations onto it, and exposes the four CRUD operations
//! the HTTP layer needs (`list_apps`, `find_app`, `insert_app`,
//! `replace_app`, `delete_app`). Every method speaks in [`AppEntry`]: the
//! domain struct doubles as the row mapping via `sql_row!`, so the wire
//! shape, the rusqlite mapping, and the named-param array for inserts all
//! come from one field list.

use anyhow::Context;
use persistence_rust::{build_insert_sql, sql_row, Connection, DbResult};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, ToSql};

use crate::domain::{AppEntry, AppKind};

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

    /// All rows, in seed/insertion order. Used by `GET /apps` to build the
    /// catalogue.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_apps(&self) -> DbResult<Vec<AppEntry>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!("SELECT {ALL_COLS} FROM apps ORDER BY rowid"))?;
        let rows = stmt.query_map([], |row| AppEntry::try_from(row))?;
        rows.collect()
    }

    /// Single row by id, `None` when absent.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_app(&self, id: &str) -> DbResult<Option<AppEntry>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM apps WHERE id = ?1"),
                params![id],
                |row| AppEntry::try_from(row),
            )
            .optional()
    }

    /// Insert a fresh row, returning `false` when the id is already taken.
    /// `INSERT … ON CONFLICT(id) DO NOTHING` keeps the duplicate-id case
    /// out of the error path so the handler can pick a different id rather
    /// than swallow a constraint violation.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the insert.
    pub fn insert_app(&self, app: &AppEntry) -> DbResult<bool> {
        let params = make_named_sql_params(app);
        let sql = format!(
            "{} ON CONFLICT(id) DO NOTHING",
            build_insert_sql("apps", &params),
        );
        let affected = self.conn().lock().execute(&sql, &params[..])?;
        Ok(affected == 1)
    }

    /// Replace an existing row's mutable columns with `app`'s values
    /// (everything except the primary key). Returns `true` when a row
    /// matched, `false` when no row had that id.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update.
    pub fn replace_app(&self, app: &AppEntry) -> DbResult<bool> {
        // Hand-written UPDATE — the column list mirrors `sql_row!`'s
        // `ALL_COLS` minus `id`. Drift would surface as either a
        // "no such column" SQL error or a stale value caught by the
        // round-trip tests; the field list is short enough that pinning
        // the SET clause is clearer than a runtime SQL builder.
        const SQL: &str = "UPDATE apps SET \
            kind = :kind, \
            enabled = :enabled, \
            name = :name, \
            subtitle = :subtitle, \
            url = :url, \
            requires_tunnel = :requires_tunnel \
            WHERE id = :id";
        let params = make_named_sql_params(app);
        let affected = self.conn().lock().execute(SQL, &params[..])?;
        Ok(affected == 1)
    }

    /// Delete a row by id. Returns `true` when a row was actually removed,
    /// `false` when no row had that id. Bundled rows are deletable like
    /// any other — `kind` is a display-only hint.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the delete.
    pub fn delete_app(&self, id: &str) -> DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM apps WHERE id = ?1", params![id])?;
        Ok(affected == 1)
    }
}

impl ToSql for AppKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

impl FromSql for AppKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse::<AppKind>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

// `AppEntry`'s field names match the SQL column names, so the macro
// derives `TryFrom<&Row>`, `make_named_sql_params`, and `ALL_COLS` off the
// single field list — no separate row type, no projection layer.
sql_row!(AppEntry {
    id,
    kind,
    enabled,
    name,
    subtitle,
    url,
    requires_tunnel,
});

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
/// already-shipped entry. A new bundled app (or any other schema change)
/// lands as a sibling `.sql` file under `src/migrations/` plus one new
/// `include_str!` line below. Because each migration runs only once per
/// database, a user-deleted bundled row stays deleted across upgrades —
/// only fresh installs see the full default set.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/001_initial_schema.sql")];

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, kind: AppKind, url: &str) -> AppEntry {
        AppEntry {
            id: id.to_owned(),
            kind,
            enabled: true,
            name: id.to_owned(),
            subtitle: None,
            url: url.to_owned(),
            requires_tunnel: false,
        }
    }

    #[test]
    fn migrate_is_idempotent_and_creates_the_apps_table() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='apps'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(exists, "apps table must exist after migrate");
    }

    /// The seed migration creates the well-known bundled rows verbatim.
    /// FHIR Sharing is intentionally NOT among them — tunnel control has
    /// its own UI surface and is no longer part of the apps catalogue.
    #[test]
    fn migration_seeds_the_bundled_set_without_fhir_sharing() {
        let store = AppsStore::open_in_memory().unwrap();
        let rows = store.list_apps().unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        for expected in [
            "patient-browser",
            "api-view",
            "api-docs",
            "growth-chart",
            "medication-viewer",
        ] {
            assert!(
                ids.contains(&expected),
                "missing seeded id {expected} in {ids:?}",
            );
        }
        assert!(
            !ids.contains(&"fhir-sharing"),
            "fhir-sharing should be gone from the seed: {ids:?}",
        );
    }

    #[test]
    fn insert_app_round_trips_through_find_app() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = entry("custom-x", AppKind::Custom, "https://example.com/launch");
        assert!(store.insert_app(&app).unwrap());
        let fetched = store.find_app("custom-x").unwrap().expect("present");
        assert_eq!(fetched, app);
    }

    #[test]
    fn insert_app_returns_false_on_duplicate_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = entry("custom-x", AppKind::Custom, "https://example.com/x");
        assert!(store.insert_app(&app).unwrap());
        assert!(
            !store.insert_app(&app).unwrap(),
            "second insert with the same id is a NO-OP",
        );
    }

    /// `replace_app` mutates every column except the primary key. Used by
    /// the patch handler after merging the body into the existing row.
    #[test]
    fn replace_app_writes_all_mutable_columns() {
        let store = AppsStore::open_in_memory().unwrap();
        let mut app = entry("custom-x", AppKind::Custom, "https://example.com/x");
        store.insert_app(&app).unwrap();

        app.name = "Renamed".into();
        app.subtitle = Some("the new subtitle".into());
        app.url = "{origin}/path".into();
        app.requires_tunnel = true;
        app.enabled = false;
        assert!(store.replace_app(&app).unwrap());

        let fetched = store.find_app("custom-x").unwrap().expect("present");
        assert_eq!(fetched, app);
    }

    #[test]
    fn replace_app_returns_false_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = entry("ghost", AppKind::Custom, "https://example.com/x");
        assert!(!store.replace_app(&app).unwrap());
    }

    /// Bundled rows are first-class editable. The patch flow can rename,
    /// re-point, and disable any of them.
    #[test]
    fn bundled_seeded_rows_are_editable_through_replace_app() {
        let store = AppsStore::open_in_memory().unwrap();
        let mut app = store
            .find_app("patient-browser")
            .unwrap()
            .expect("seeded row");
        assert_eq!(app.kind, AppKind::Bundled);
        app.name = "Renamed Patient Browser".into();
        app.url = "https://example.com/replacement".into();
        app.enabled = false;
        assert!(store.replace_app(&app).unwrap());

        let fetched = store
            .find_app("patient-browser")
            .unwrap()
            .expect("still present");
        assert_eq!(fetched.name, "Renamed Patient Browser");
        assert_eq!(fetched.url, "https://example.com/replacement");
        assert!(!fetched.enabled);
        // Provenance survives the edit so the UI can still label it.
        assert_eq!(fetched.kind, AppKind::Bundled);
    }

    #[test]
    fn delete_app_removes_any_row_regardless_of_kind() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(store.delete_app("patient-browser").unwrap());
        assert!(store.find_app("patient-browser").unwrap().is_none());

        let custom = entry("custom-y", AppKind::Custom, "https://example.com/y");
        store.insert_app(&custom).unwrap();
        assert!(store.delete_app("custom-y").unwrap());
        assert!(store.find_app("custom-y").unwrap().is_none());
    }

    #[test]
    fn delete_app_returns_false_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(!store.delete_app("no-such-id").unwrap());
    }
}

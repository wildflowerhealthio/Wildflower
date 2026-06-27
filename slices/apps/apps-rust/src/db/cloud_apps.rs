//! Cloud-app reads + writes on the [`AppsStore`] — a second `impl AppsStore`
//! block. A cloud app spans two tables: the parent `apps` registry row and the
//! `cloud_apps` child (the `url` template + `requires_tunnel`). Every method
//! speaks in [`AppEntry`], the cloud wire shape; the JOIN mapping is
//! hand-written (not `sql_row!`) because `id` / `name` / `subtitle` / `enabled`
//! come from the parent and `url` / `requires_tunnel` from the child.
//!
//! Its own module (rather than living in `apps_store.rs`) so it doesn't clash
//! with that module's `sql_row!`-generated `ALL_COLS`. See [`crate::db`].

use persistence_rust::DbResult;
use rusqlite::{params, OptionalExtension, Row};

use super::AppsStore;
use crate::domain::AppEntry;

/// Build a cloud [`AppEntry`] from a `apps` + `cloud_apps` JOIN row. The column
/// order is fixed by the `SELECT` in [`AppsStore::find_cloud_app`]; `url` maps
/// through [`AppUrl`](crate::domain::AppUrl)'s `FromSql`, so a tampered stored
/// URL surfaces as a typed read error.
fn cloud_app_from_row(row: &Row<'_>) -> rusqlite::Result<AppEntry> {
    Ok(AppEntry {
        id: row.get("id")?,
        enabled: row.get("enabled")?,
        name: row.get("name")?,
        subtitle: row.get("subtitle")?,
        url: row.get("url")?,
        requires_tunnel: row.get("requires_tunnel")?,
    })
}

impl AppsStore {
    /// A single cloud app by id — the parent registry row joined onto its
    /// `cloud_apps` child. `None` when the id is absent or is not a cloud app
    /// (no `cloud_apps` child). Backs the launch resolution and the cloud-admin
    /// update merge.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_cloud_app(&self, id: &str) -> DbResult<Option<AppEntry>> {
        self.conn()
            .lock()
            .query_row(
                "SELECT a.id, a.enabled, a.name, a.subtitle, c.url, c.requires_tunnel \
                 FROM apps a \
                 JOIN cloud_apps c ON c.id = a.id \
                 WHERE a.id = ?1",
                params![id],
                cloud_app_from_row,
            )
            .optional()
    }

    /// Insert a fresh cloud app: the parent registry row (`provenance = 'cloud'`,
    /// at `position`, not local-only, no `client_id`) AND its `cloud_apps` child,
    /// in one transaction. Returns `false` when the id is already taken (the
    /// parent `INSERT … ON CONFLICT(id) DO NOTHING` affects 0 rows → roll back so
    /// no orphan child lands).
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the insert.
    pub fn insert_cloud_app(&self, app: &AppEntry, position: i64) -> DbResult<bool> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;
        let affected = tx.execute(
            "INSERT INTO apps (id, name, subtitle, enabled, position, provenance, local_only, client_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'cloud', 0, NULL) \
             ON CONFLICT(id) DO NOTHING",
            params![app.id, app.name, app.subtitle, app.enabled, position],
        )?;
        if affected != 1 {
            // The id already exists — roll back so the child insert below never
            // runs against a parent we didn't create.
            tx.rollback()?;
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO cloud_apps (id, url, requires_tunnel) VALUES (?1, ?2, ?3)",
            params![app.id, app.url, app.requires_tunnel],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Replace an existing cloud app's mutable fields: the parent's
    /// `name`/`subtitle`/`enabled` and the child's `url`/`requires_tunnel`, in
    /// one transaction. Returns `true` iff a cloud app with that id existed (the
    /// parent `UPDATE … WHERE id = ? AND provenance = 'cloud'` matched a row), so
    /// a non-cloud id is a no-op `false`.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update.
    pub fn replace_cloud_app(&self, app: &AppEntry) -> DbResult<bool> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;
        let parent_affected = tx.execute(
            "UPDATE apps SET name = ?2, subtitle = ?3, enabled = ?4 \
             WHERE id = ?1 AND provenance = 'cloud'",
            params![app.id, app.name, app.subtitle, app.enabled],
        )?;
        if parent_affected != 1 {
            // Not a cloud app (or no such id) — leave the child untouched.
            tx.rollback()?;
            return Ok(false);
        }
        tx.execute(
            "UPDATE cloud_apps SET url = ?2, requires_tunnel = ?3 WHERE id = ?1",
            params![app.id, app.url, app.requires_tunnel],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Delete an app by id. The parent `DELETE` cascades to the `cloud_apps` /
    /// `self_hosted_apps` child (`ON DELETE CASCADE`). Returns `true` when a row
    /// was removed. The handler enforces cloud-only before calling this — the
    /// store doesn't gate on provenance here (any row is removable at the SQL
    /// level).
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AppUrl;

    fn cloud(id: &str, url: AppUrl) -> AppEntry {
        AppEntry {
            id: id.to_owned(),
            enabled: true,
            name: id.to_owned(),
            subtitle: None,
            url,
            requires_tunnel: false,
        }
    }

    fn external(url: &str) -> AppUrl {
        AppUrl::External(url.to_owned())
    }

    #[test]
    fn insert_cloud_app_round_trips_through_find_cloud_app() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = cloud("app-x", external("https://example.com/launch"));
        let pos = store.next_position().unwrap();
        assert!(store.insert_cloud_app(&app, pos).unwrap());
        let fetched = store.find_cloud_app("app-x").unwrap().expect("present");
        assert_eq!(fetched, app);
        // And the parent registry row exists with cloud provenance at `pos`.
        let parent = store.find_app("app-x").unwrap().expect("parent");
        assert_eq!(parent.provenance, crate::domain::Provenance::Cloud);
        assert_eq!(parent.position, pos);
        assert!(!parent.smart(), "inserted cloud app has no client_id");
    }

    #[test]
    fn insert_cloud_app_returns_false_on_duplicate_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = cloud("app-x", external("https://example.com/x"));
        assert!(store.insert_cloud_app(&app, 10).unwrap());
        assert!(
            !store.insert_cloud_app(&app, 11).unwrap(),
            "second insert with the same id is a NO-OP",
        );
        // The failed insert left no orphan child and didn't move the position.
        assert_eq!(store.find_app("app-x").unwrap().unwrap().position, 10);
    }

    /// A seeded cloud app's id can't be re-created — the parent PK rejects it and
    /// the child insert never runs.
    #[test]
    fn insert_cloud_app_rejects_a_seeded_id_without_orphaning_a_child() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = cloud("growth-chart", external("https://example.com/x"));
        assert!(!store.insert_cloud_app(&app, 99).unwrap());
        // The original child url is untouched.
        let fetched = store.find_cloud_app("growth-chart").unwrap().unwrap();
        assert!(fetched.url.to_string().contains("growth-chart-app"));
    }

    #[test]
    fn replace_cloud_app_writes_parent_and_child() {
        let store = AppsStore::open_in_memory().unwrap();
        let mut app = cloud("app-x", external("https://example.com/x"));
        store.insert_cloud_app(&app, 0).unwrap();

        app.name = "Renamed".into();
        app.subtitle = Some("the new subtitle".into());
        app.url = AppUrl::OriginRelative("/path".to_owned());
        app.requires_tunnel = true;
        app.enabled = false;
        assert!(store.replace_cloud_app(&app).unwrap());

        let fetched = store.find_cloud_app("app-x").unwrap().expect("present");
        assert_eq!(fetched, app);
    }

    /// `replace_cloud_app` only touches cloud apps — a self-hosted / system id is
    /// a no-op `false`, and crucially does NOT mutate the parent row.
    #[test]
    fn replace_cloud_app_ignores_non_cloud_ids() {
        let store = AppsStore::open_in_memory().unwrap();
        // patient-browser is self-hosted; api-docs is system.
        for id in ["patient-browser", "api-docs"] {
            let app = cloud(id, external("https://example.com/tampered"));
            assert!(
                !store.replace_cloud_app(&app).unwrap(),
                "{id} is not a cloud app",
            );
            // Its parent name is unchanged.
            let parent = store.find_app(id).unwrap().unwrap();
            assert_ne!(parent.name, id, "{id} parent row must be untouched");
        }
    }

    #[test]
    fn replace_cloud_app_returns_false_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = cloud("ghost", external("https://example.com/x"));
        assert!(!store.replace_cloud_app(&app).unwrap());
    }

    #[test]
    fn delete_app_cascades_to_the_child() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(store.delete_app("growth-chart").unwrap());
        assert!(store.find_app("growth-chart").unwrap().is_none());
        assert!(store.find_cloud_app("growth-chart").unwrap().is_none());
        // The child row is gone too (CASCADE).
        let child_count: i64 = store
            .conn()
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM cloud_apps WHERE id = 'growth-chart'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(child_count, 0);
    }

    #[test]
    fn delete_app_returns_false_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(!store.delete_app("no-such-id").unwrap());
    }

    /// A cloud row whose stored child `url` no longer parses surfaces as a typed
    /// read error (via `AppUrl`'s `FromSql`), not a silent unsafe value.
    #[test]
    fn find_cloud_app_rejects_an_unparseable_stored_url() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .conn()
            .lock()
            .execute(
                "UPDATE cloud_apps SET url = 'http://evil.example.com' WHERE id = 'growth-chart'",
                [],
            )
            .unwrap();
        assert!(store.find_cloud_app("growth-chart").is_err());
    }
}

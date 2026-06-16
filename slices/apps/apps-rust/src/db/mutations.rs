//! Writer methods used by the admin handlers. Three operations:
//!
//!   * [`AppsStore::create_custom_app`] — insert a fresh `custom` row.
//!   * [`AppsStore::update_app`] — patch an existing row's enabled flag
//!     and/or (for custom rows) name/url/requires_tunnel.
//!   * [`AppsStore::delete_custom_app`] — delete a `custom` row.
//!
//! Bundled-row protection is enforced here in code, not at the SQL layer,
//! because the handler needs to distinguish "no such app" (404) from
//! "you can't mutate this one" (403). The handler reads the row first
//! and decides; these methods trust their caller.

use rusqlite::{named_params, params};

use crate::db::{AppRow, AppsStore};
use persistence_rust::DbResult;

/// Insert payload — what `POST /apps` writes for a fresh custom row.
#[derive(Debug, Clone)]
pub struct CreateCustomApp {
    pub id: String,
    pub name: String,
    pub url: String,
    pub requires_tunnel: bool,
}

/// Patch payload — every field is optional; a `None` keeps the persisted
/// value. The handler validates which fields are legal for which `kind`
/// before calling.
#[derive(Debug, Clone, Default)]
pub struct UpdateApp {
    pub enabled: Option<bool>,
    pub name: Option<String>,
    pub url: Option<String>,
    pub requires_tunnel: Option<bool>,
}

/// Result of an update — either `Updated(row)` carrying the post-update row,
/// or `NotFound` when nothing matched the id (the handler's hint to 404).
#[derive(Debug, Clone)]
pub enum UpdateOutcome {
    Updated(AppRow),
    NotFound,
}

impl AppsStore {
    /// Insert a fresh custom row. Returns `false` when `id` is already taken
    /// (the handler picks a fresh nanoid so this shouldn't happen in normal
    /// operation; surfacing it explicitly keeps the swallow blameable if it
    /// ever does).
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the insert.
    pub fn create_custom_app(&self, app: &CreateCustomApp) -> DbResult<bool> {
        let conn = self.conn().lock();
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO apps \
                (id, kind, enabled, custom_name, custom_url, custom_requires_tunnel) \
             VALUES (?1, 'custom', 1, ?2, ?3, ?4)",
            params![&app.id, &app.name, &app.url, app.requires_tunnel],
        )?;
        Ok(inserted == 1)
    }

    /// Patch an existing row. Returns the post-update row, or `NotFound`
    /// when no row had that id.
    ///
    /// The SQL uses `COALESCE(:bind, column)` so a NULL bind (field omitted)
    /// falls through to the stored value, while a non-null bind replaces it.
    /// This keeps the UPDATE one statement regardless of which subset of
    /// columns the patch touches.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update or the read-back.
    pub fn update_app(&self, id: &str, patch: &UpdateApp) -> DbResult<UpdateOutcome> {
        let conn = self.conn().lock();
        let affected = conn.execute(
            "UPDATE apps SET \
                enabled                = COALESCE(:enabled, enabled), \
                custom_name            = COALESCE(:name, custom_name), \
                custom_url             = COALESCE(:url, custom_url), \
                custom_requires_tunnel = COALESCE(:requires_tunnel, custom_requires_tunnel) \
             WHERE id = :id",
            named_params! {
                ":enabled": patch.enabled,
                ":name": patch.name.as_deref(),
                ":url": patch.url.as_deref(),
                ":requires_tunnel": patch.requires_tunnel,
                ":id": id,
            },
        )?;
        if affected == 0 {
            return Ok(UpdateOutcome::NotFound);
        }
        let updated = conn
            .query_row(
                "SELECT id, kind, enabled, custom_name, custom_url, custom_requires_tunnel \
                 FROM apps WHERE id = ?1",
                [id],
                |row| AppRow::try_from(row),
            )
            // The row existed at UPDATE time and we hold the connection lock
            // across both statements, so it must still exist at SELECT time.
            .map_err(|e| {
                tracing::error!(
                    error = %e,
                    app_id = id,
                    "row disappeared between UPDATE and SELECT under the same connection lock",
                );
                e
            })?;
        Ok(UpdateOutcome::Updated(updated))
    }

    /// Delete a custom row. Returns `true` when a row was actually removed,
    /// `false` when no row had that id.
    ///
    /// The caller (the admin handler) must have already confirmed the row is
    /// `kind = 'custom'` — this method does not protect bundled rows.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the delete.
    pub fn delete_custom_app(&self, id: &str) -> DbResult<bool> {
        let conn = self.conn().lock();
        let affected = conn.execute("DELETE FROM apps WHERE id = ?1 AND kind = 'custom'", [id])?;
        Ok(affected == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create() -> CreateCustomApp {
        CreateCustomApp {
            id: "custom-abc".into(),
            name: "My App".into(),
            url: "https://example.com/launch".into(),
            requires_tunnel: false,
        }
    }

    #[test]
    fn create_custom_app_inserts_a_row_visible_to_find_app() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(store.create_custom_app(&create()).unwrap());
        let row = store.find_app("custom-abc").unwrap().expect("present");
        assert_eq!(row.kind, "custom");
        assert!(row.enabled);
        assert_eq!(row.custom_name.as_deref(), Some("My App"));
        assert_eq!(
            row.custom_url.as_deref(),
            Some("https://example.com/launch")
        );
        assert_eq!(row.custom_requires_tunnel, Some(false));
    }

    #[test]
    fn create_custom_app_returns_false_on_duplicate_id() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(store.create_custom_app(&create()).unwrap());
        assert!(
            !store.create_custom_app(&create()).unwrap(),
            "second insert with the same id is a NO-OP",
        );
    }

    /// A partial update that only touches `enabled` must leave the other
    /// columns alone — the COALESCE wiring lives or dies on this.
    #[test]
    fn update_app_with_only_enabled_keeps_name_and_url() {
        let store = AppsStore::open_in_memory().unwrap();
        store.create_custom_app(&create()).unwrap();
        let outcome = store
            .update_app(
                "custom-abc",
                &UpdateApp {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        let UpdateOutcome::Updated(row) = outcome else {
            panic!("expected Updated, got {outcome:?}");
        };
        assert!(!row.enabled);
        assert_eq!(row.custom_name.as_deref(), Some("My App"));
        assert_eq!(
            row.custom_url.as_deref(),
            Some("https://example.com/launch")
        );
    }

    #[test]
    fn update_app_returns_not_found_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let outcome = store
            .update_app(
                "ghost",
                &UpdateApp {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(matches!(outcome, UpdateOutcome::NotFound));
    }

    /// Enabling/disabling a bundled row goes through the same `update_app`
    /// SQL — the COALESCE leaves the `custom_*` columns at NULL, which the
    /// schema's CHECK trigger requires for bundled rows.
    #[test]
    fn update_app_can_flip_enabled_on_a_seeded_bundled_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let outcome = store
            .update_app(
                "patient-browser",
                &UpdateApp {
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        let UpdateOutcome::Updated(row) = outcome else {
            panic!("expected Updated, got {outcome:?}");
        };
        assert!(!row.enabled);
        assert_eq!(row.kind, "bundled");
        assert!(row.custom_name.is_none());
    }

    #[test]
    fn delete_custom_app_only_removes_custom_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        store.create_custom_app(&create()).unwrap();
        assert!(store.delete_custom_app("custom-abc").unwrap());
        assert!(store.find_app("custom-abc").unwrap().is_none());
        // bundled rows refuse the delete
        assert!(!store.delete_custom_app("patient-browser").unwrap());
        assert!(store.find_app("patient-browser").unwrap().is_some());
    }
}

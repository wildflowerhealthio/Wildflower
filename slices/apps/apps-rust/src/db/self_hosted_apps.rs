//! Read-only row mapping + queries for the `self_hosted_apps` child table
//! (seeded by migration, not editable through the cloud-admin API). A second
//! `impl AppsStore` block, its own module per [`crate::db`].
//!
//! The child carries `id`, the loopback `port`, the on-disk `content_folder`, and
//! the public `subdomain` label — the catalogue fields (name, subtitle, enabled)
//! live on the parent registry row. The host reads this to discover which loopback
//! listeners to bind (and from which folder), and the proxy key (`subdomain`); the
//! launch handler reads it for the port and subdomain.

use persistence_rust::{sql_row, DbResult};
use rusqlite::{params, OptionalExtension};

use super::AppsStore;
use crate::domain::SelfHostedApp;

impl AppsStore {
    /// Every self-hosted child row, in seed/insertion order. The host materializes
    /// this once at setup to bind a loopback listener per row.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_self_hosted_apps(&self) -> DbResult<Vec<SelfHostedApp>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ALL_COLS} FROM self_hosted_apps ORDER BY rowid"
        ))?;
        let rows = stmt.query_map([], |row| SelfHostedApp::try_from(row))?;
        rows.collect()
    }

    /// A single self-hosted child row by id, `None` when absent. Backs the launch
    /// handler's self-hosted target resolution (it needs the `port`).
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_self_hosted_app(&self, id: &str) -> DbResult<Option<SelfHostedApp>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM self_hosted_apps WHERE id = ?1"),
                params![id],
                |row| SelfHostedApp::try_from(row),
            )
            .optional()
    }
}

// Field names match the SQL column names; the macro derives `TryFrom<&Row>`
// and `ALL_COLS` off the field list.
sql_row!(SelfHostedApp {
    id,
    port,
    content_folder,
    subdomain
});

#[cfg(test)]
mod tests {
    use crate::db::AppsStore;

    /// The store hands back the seeded child row with its port, content folder,
    /// and subdomain intact. The catalogue fields live on the parent registry row
    /// (asserted in `apps_store` tests).
    #[test]
    fn list_returns_the_seeded_patient_browser_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let rows = store.list_self_hosted_apps().unwrap();
        let pb = rows
            .iter()
            .find(|r| r.id == "patient-browser")
            .expect("patient-browser is seeded");
        assert_eq!(pb.port, 8081);
        assert_eq!(pb.content_folder, "patient-browser");
        assert_eq!(pb.subdomain, "patient-browser");
    }

    #[test]
    fn find_returns_some_for_a_seeded_id_and_none_otherwise() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(store
            .find_self_hosted_app("patient-browser")
            .unwrap()
            .is_some());
        assert!(store.find_self_hosted_app("no-such-id").unwrap().is_none());
    }
}

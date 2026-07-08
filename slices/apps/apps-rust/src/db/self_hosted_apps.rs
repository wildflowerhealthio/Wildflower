//! Row mapping + queries for the `self_hosted_apps` child table. A second
//! `impl AppsStore` block, its own module per [`crate::db`].
//!
//! The child carries `id`, the loopback `port`, the on-disk `content_folder`,
//! the public `subdomain` label, the `seeded` flag, and the nullable
//! `launch_path` (the install-inferred SMART launch path) — the catalogue
//! fields (name, subtitle, enabled) live on the parent registry row.
//! Migration-seeded
//! rows (`seeded = 1`) are read-only through the admin surface; rows created at
//! runtime through the upload surface (`insert_self_hosted_app`, `seeded = 0`)
//! are removable.
//!
//! The host reads this to discover which loopback listeners to bind (and from
//! which folder), and the proxy key (`subdomain`); the launch handler reads it
//! for the port and subdomain.

use persistence_rust::{sql_row, DbResult};
use rusqlite::{params, OptionalExtension};

use super::AppsStore;
use crate::domain::SelfHostedAppRow;

/// The smallest loopback port an uploaded app is allocated. The seed
/// (patient-browser) sits at 8081, so uploads start one above it; the host's own
/// loopback API port is passed in as a reserved port and skipped.
const MIN_UPLOAD_PORT: i64 = 8082;

/// Attempts at suffixing a base slug (`-2`, `-3`, …) before giving up. A clash
/// past this many candidates is treated as "couldn't allocate a unique slug".
const MAX_SLUG_ATTEMPTS: u32 = 50;

impl AppsStore {
    /// Every self-hosted child row, in seed/insertion order. The host materializes
    /// this once at setup to bind a loopback listener per row.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_self_hosted_apps(&self) -> DbResult<Vec<SelfHostedAppRow>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ALL_COLS} FROM self_hosted_apps ORDER BY rowid"
        ))?;
        let rows = stmt.query_map([], |row| SelfHostedAppRow::try_from(row))?;
        rows.collect()
    }

    /// A single self-hosted child row by id, `None` when absent. Backs the launch
    /// handler's self-hosted target resolution (it needs the `port`) and the
    /// delete handler's seeded/removable check (it needs `seeded`).
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_self_hosted_app(&self, id: &str) -> DbResult<Option<SelfHostedAppRow>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM self_hosted_apps WHERE id = ?1"),
                params![id],
                |row| SelfHostedAppRow::try_from(row),
            )
            .optional()
    }

    /// Insert a fresh uploaded self-hosted app: the parent registry row
    /// (`provenance = 'self-hosted'`, `local_only = 1`, `enabled = 1`) AND its
    /// `self_hosted_apps` child (`seeded = 0`), in one transaction (mirroring
    /// [`insert_cloud_app`](AppsStore::insert_cloud_app)).
    ///
    /// The slug is derived by the handler; here it's made unique against **both**
    /// the parent `apps.id` and the `self_hosted_apps.subdomain` by suffixing
    /// `-2`, `-3`, … (up to [`MAX_SLUG_ATTEMPTS`]). The chosen slug becomes the
    /// row's `id`, `content_folder`, and `subdomain` alike. The port is the next
    /// free one at or above [`MIN_UPLOAD_PORT`] (`MAX(port) + 1`, skipping any
    /// `reserved_ports` — the host loopback port); the position is appended at
    /// `MAX(position) + 1`. All three are computed **inside** the transaction so
    /// overlapping creates can't collide.
    ///
    /// `launch_path` is the launch path inferred at install (see
    /// [`SelfHostedAppRow::launch_path`]) — `None` for a root-served bundle.
    ///
    /// Returns `Ok(None)` when no unique slug is found within the attempt budget
    /// or the port space is exhausted (the handler maps that to `400`), and the
    /// inserted [`SelfHostedAppRow`] otherwise.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn insert_self_hosted_app(
        &self,
        name: &str,
        subtitle: Option<&str>,
        base_slug: &str,
        reserved_ports: &[u16],
        launch_path: Option<&str>,
    ) -> DbResult<Option<SelfHostedAppRow>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;

        // Find a slug free of both the global id space and the subdomain space.
        let mut chosen_slug = None;
        for attempt in 1..=MAX_SLUG_ATTEMPTS {
            let candidate = if attempt == 1 {
                base_slug.to_owned()
            } else {
                format!("{base_slug}-{attempt}")
            };
            let id_taken: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM apps WHERE id = ?1)",
                params![candidate],
                |row| row.get(0),
            )?;
            let subdomain_taken: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM self_hosted_apps WHERE subdomain = ?1)",
                params![candidate],
                |row| row.get(0),
            )?;
            if !id_taken && !subdomain_taken {
                chosen_slug = Some(candidate);
                break;
            }
        }
        let Some(slug) = chosen_slug else {
            // Drop the transaction unwritten; the handler maps `None` to a 400.
            return Ok(None);
        };

        let Some(port) = next_free_port(&tx, reserved_ports)? else {
            return Ok(None);
        };
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM apps",
            [],
            |row| row.get(0),
        )?;

        tx.execute(
            "INSERT INTO apps (id, name, subtitle, enabled, position, provenance, local_only, client_id) \
             VALUES (?1, ?2, ?3, 1, ?4, 'self-hosted', 1, NULL)",
            params![slug, name, subtitle, position],
        )?;
        tx.execute(
            "INSERT INTO self_hosted_apps (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES (?1, ?2, ?1, ?1, 0, ?3)",
            params![slug, port, launch_path],
        )?;
        tx.commit()?;

        Ok(Some(SelfHostedAppRow {
            id: slug.clone(),
            port,
            content_folder: slug.clone(),
            subdomain: slug,
            seeded: false,
            launch_path: launch_path.map(str::to_owned),
        }))
    }

    /// Update a self-hosted app's `launch_path` (see
    /// [`SelfHostedAppRow::launch_path`]); `None` clears it back to
    /// root-serving. Returns `true` when a row matched. The update handler
    /// enforces "self-hosted and not seeded" before calling this.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update.
    pub fn update_self_hosted_launch_path(
        &self,
        id: &str,
        launch_path: Option<&str>,
    ) -> DbResult<bool> {
        let affected = self.conn().lock().execute(
            "UPDATE self_hosted_apps SET launch_path = ?2 WHERE id = ?1",
            params![id, launch_path],
        )?;
        Ok(affected == 1)
    }

    /// Delete a self-hosted app by id — the parent `DELETE` cascades to the
    /// `self_hosted_apps` child (`ON DELETE CASCADE`). Returns `true` when a row
    /// was removed. The delete handler enforces "self-hosted and not seeded"
    /// before calling this; the create handler calls it to roll back a row whose
    /// staged files couldn't be moved into place.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the delete.
    pub fn delete_self_hosted_app(&self, id: &str) -> DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM apps WHERE id = ?1", params![id])?;
        Ok(affected == 1)
    }
}

/// The next free loopback port at or above [`MIN_UPLOAD_PORT`]: `MAX(port) + 1`
/// clamped up to the floor, then advanced past any `reserved_ports` (the host
/// loopback port). `None` if the u16 port space is exhausted (unreachable in
/// practice — it needs tens of thousands of installed apps). Computed on the
/// open transaction so it can't race a concurrent insert.
fn next_free_port(tx: &rusqlite::Transaction<'_>, reserved_ports: &[u16]) -> DbResult<Option<u16>> {
    let next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(port), ?1) + 1 FROM self_hosted_apps",
        params![MIN_UPLOAD_PORT - 1],
        |row| row.get(0),
    )?;
    let mut candidate = next.max(MIN_UPLOAD_PORT);
    loop {
        if candidate > i64::from(u16::MAX) {
            return Ok(None);
        }
        // Safe: `candidate <= u16::MAX` and `> 0` here.
        let port = candidate as u16;
        if !reserved_ports.contains(&port) {
            return Ok(Some(port));
        }
        candidate += 1;
    }
}

// Field names match the SQL column names; the macro derives `TryFrom<&Row>`
// and `ALL_COLS` off the field list.
sql_row!(SelfHostedAppRow {
    id,
    port,
    content_folder,
    subdomain,
    seeded,
    launch_path
});

#[cfg(test)]
mod tests {
    use crate::db::AppsStore;

    /// The store hands back the seeded child row with its port, content folder,
    /// subdomain, and the `seeded` flag set. The catalogue fields live on the
    /// parent registry row (asserted in `apps_store` tests).
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
        assert!(pb.seeded, "the migration-seeded row must be flagged seeded");
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

    /// An inserted upload lands one port above the seed (8081 → 8082), appends at
    /// the next position (after the six seeded rows → 6), and is flagged
    /// non-seeded.
    #[test]
    fn insert_allocates_the_next_port_and_position() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = store
            .insert_self_hosted_app("My App", None, "my-app", &[], None)
            .unwrap()
            .expect("inserted");
        assert_eq!(app.id, "my-app");
        assert_eq!(app.port, 8082);
        assert_eq!(app.content_folder, "my-app");
        assert_eq!(app.subdomain, "my-app");
        assert!(!app.seeded);

        let parent = store.find_app("my-app").unwrap().expect("parent row");
        assert_eq!(parent.provenance, crate::domain::Provenance::SelfHosted);
        assert_eq!(parent.position, 6);
        assert!(parent.local_only);
        assert!(parent.enabled);

        // A second upload takes the next port and position.
        let app2 = store
            .insert_self_hosted_app("Other", None, "other", &[], None)
            .unwrap()
            .expect("inserted");
        assert_eq!(app2.port, 8083);
        assert_eq!(store.find_app("other").unwrap().unwrap().position, 7);
    }

    /// A `launch_path` supplied at insert round-trips through both the
    /// insert return and a fresh `find`; an app inserted without one reads back
    /// `None`.
    #[test]
    fn insert_persists_and_reads_back_the_launch_path() {
        let store = AppsStore::open_in_memory().unwrap();
        let template = "/launch.html?launch={launch}&iss={origin}/fhir-r4";
        let inserted = store
            .insert_self_hosted_app("Launcher", None, "launcher", &[], Some(template))
            .unwrap()
            .expect("inserted");
        assert_eq!(inserted.launch_path.as_deref(), Some(template));

        let found = store
            .find_self_hosted_app("launcher")
            .unwrap()
            .expect("found");
        assert_eq!(found.launch_path.as_deref(), Some(template));

        let rootless = store
            .insert_self_hosted_app("Rootless", None, "rootless", &[], None)
            .unwrap()
            .expect("inserted");
        assert_eq!(rootless.launch_path, None);
    }

    /// `update_self_hosted_launch_path` sets, replaces, and clears the
    /// column; an unknown id matches nothing.
    #[test]
    fn update_launch_path_sets_replaces_and_clears() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_self_hosted_app("App", None, "app", &[], None)
            .unwrap()
            .expect("inserted");

        assert!(store
            .update_self_hosted_launch_path("app", Some("/launch.html"))
            .unwrap());
        assert_eq!(
            store
                .find_self_hosted_app("app")
                .unwrap()
                .unwrap()
                .launch_path
                .as_deref(),
            Some("/launch.html"),
        );

        assert!(store.update_self_hosted_launch_path("app", None).unwrap());
        assert_eq!(
            store
                .find_self_hosted_app("app")
                .unwrap()
                .unwrap()
                .launch_path,
            None,
        );

        assert!(
            !store
                .update_self_hosted_launch_path("ghost", Some("/x"))
                .unwrap(),
            "an unknown id matches no row",
        );
    }

    /// A reserved port (the host loopback port) is skipped in the allocation.
    #[test]
    fn insert_skips_reserved_ports() {
        let store = AppsStore::open_in_memory().unwrap();
        // 8082 would be next, but it's reserved → 8083.
        let app = store
            .insert_self_hosted_app("My App", None, "my-app", &[8082], None)
            .unwrap()
            .expect("inserted");
        assert_eq!(app.port, 8083);
    }

    /// A base slug colliding with the seeded `patient-browser` is suffixed `-2`.
    #[test]
    fn insert_suffixes_a_colliding_slug() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = store
            .insert_self_hosted_app("Patient Browser", None, "patient-browser", &[], None)
            .unwrap()
            .expect("inserted");
        assert_eq!(app.id, "patient-browser-2");
        assert_eq!(app.subdomain, "patient-browser-2");
        assert_eq!(app.content_folder, "patient-browser-2");

        // A third with the same base skips to `-3`.
        let app3 = store
            .insert_self_hosted_app("Patient Browser", None, "patient-browser", &[], None)
            .unwrap()
            .expect("inserted");
        assert_eq!(app3.id, "patient-browser-3");
    }

    /// Delete removes both the parent and the child (CASCADE).
    #[test]
    fn delete_removes_both_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = store
            .insert_self_hosted_app("My App", None, "my-app", &[], None)
            .unwrap()
            .expect("inserted");
        assert!(store.delete_self_hosted_app(&app.id).unwrap());
        assert!(store.find_app("my-app").unwrap().is_none());
        assert!(store.find_self_hosted_app("my-app").unwrap().is_none());
        assert!(
            !store.delete_self_hosted_app("my-app").unwrap(),
            "a second delete of the same id removes nothing",
        );
    }

    /// The `removable` flag on the list projection: cloud + uploaded self-hosted
    /// are removable; system + seeded self-hosted are not.
    #[test]
    fn list_reports_removable_per_provenance_and_seeded() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_self_hosted_app("My App", None, "my-app", &[], None)
            .unwrap()
            .expect("inserted");
        let entries = store.list_app_entries().unwrap();
        let by_id = |id: &str| entries.iter().find(|e| e.id() == id).expect("row");
        assert!(by_id("my-app").removable(), "an uploaded app is removable");
        assert!(
            by_id("growth-chart").removable(),
            "a cloud app is removable"
        );
        assert!(
            !by_id("patient-browser").removable(),
            "the seeded self-hosted app is not removable",
        );
        assert!(
            !by_id("api-docs").removable(),
            "a system app is not removable"
        );
    }
}

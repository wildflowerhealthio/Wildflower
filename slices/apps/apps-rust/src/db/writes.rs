//! The store's write side. Every mutator is one transaction over the parent
//! `apps` row and (where the kind has one) its child table, takes a
//! [`write_inputs`](super::write_inputs) spec rather than loose scalars, and —
//! for create / replace — returns the hydrated [`App`] re-read *inside that same
//! transaction* (via [`find_app_on`](super::reads::find_app_on)). The
//! transaction discipline (in-txn read-back, in-txn allocation, single writer of
//! order/enabled) and why policy gating stays in the handlers are explained in
//! `docs/Apps/Store and Install Explanation.md` §"Transaction discipline".

use std::collections::HashSet;

use persistence_rust::DbResult;
use rusqlite::params;

use super::reads::{find_app_on, list_apps_on};
use super::write_inputs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};
use super::AppsStore;
use crate::domain::App;

/// The smallest loopback port an uploaded app is allocated — one above the
/// seeded patient-browser at 8081. See the port-allocation section of
/// `docs/Apps/Store and Install Explanation.md`.
const MIN_UPLOAD_PORT: i64 = 8082;

/// Attempts at suffixing a base slug (`-2`, `-3`, …) before reporting
/// [`UploadInsertError::SlugSpaceExhausted`].
const MAX_SLUG_ATTEMPTS: u32 = 50;

impl AppsStore {
    /// Insert a fresh cloud app: the parent registry row (`provenance = 'cloud'`,
    /// not local-only, no `client_id`, enabled) AND its `cloud_apps` child, in
    /// one transaction, appended at the next display position.
    ///
    /// Returns `Ok(None)` when the id is already taken (the parent
    /// `INSERT … ON CONFLICT(id) DO NOTHING` affects 0 rows → roll back so no
    /// orphan child lands), else the inserted whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn insert_cloud_app(&self, new: &NewCloudApp) -> DbResult<Option<App>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;
        let position = next_position(&tx)?;
        let affected = tx.execute(
            "INSERT INTO apps (id, name, subtitle, enabled, position, provenance, local_only, client_id) \
             VALUES (?1, ?2, ?3, 1, ?4, 'cloud', 0, NULL) \
             ON CONFLICT(id) DO NOTHING",
            params![new.id, new.content.name, new.content.subtitle, position],
        )?;
        if affected != 1 {
            // The id already exists — roll back so the child insert below never
            // runs against a parent we didn't create.
            tx.rollback()?;
            return Ok(None);
        }
        tx.execute(
            "INSERT INTO cloud_apps (id, url, requires_tunnel) VALUES (?1, ?2, ?3)",
            params![new.id, new.content.url, new.content.requires_tunnel],
        )?;
        let app = find_app_on(&tx, &new.id)?;
        tx.commit()?;
        Ok(app)
    }

    /// Insert a fresh uploaded self-hosted app: the parent registry row
    /// (`provenance = 'self-hosted'`, `local_only = 1`, `enabled = 1`) AND its
    /// `self_hosted_apps` child (`seeded = 0`), in one transaction.
    ///
    /// The final slug (unique against both `apps.id` and
    /// `self_hosted_apps.subdomain`, kept a valid DNS label — see
    /// [`slug_candidate`]) becomes the row's `id` and `subdomain`; the
    /// [`content_folder`](NewSelfHostedUpload::content_folder) is recorded
    /// verbatim from the spec. The port is the lowest free one from
    /// [`next_free_port`]. Slug, port, and position are all allocated **inside**
    /// the transaction — see the slug/port sections of
    /// `docs/Apps/Store and Install Explanation.md`.
    ///
    /// Returns `Ok(Err(_))` — nothing written — when the slug attempts or the
    /// port space are exhausted, distinguished by [`UploadInsertError`] so the
    /// handler can answer accurately. Otherwise the inserted whole [`App`] read
    /// back in-txn.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn insert_self_hosted_app(
        &self,
        new: &NewSelfHostedUpload,
    ) -> DbResult<Result<App, UploadInsertError>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;

        // Find a slug free of both the global id space and the subdomain space.
        let mut chosen_slug = None;
        for attempt in 1..=MAX_SLUG_ATTEMPTS {
            let candidate = slug_candidate(&new.base_slug, attempt);
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
            // Drop the transaction unwritten.
            return Ok(Err(UploadInsertError::SlugSpaceExhausted));
        };

        let Some(port) = next_free_port(&tx, &new.reserved_ports, u16::MAX)? else {
            return Ok(Err(UploadInsertError::PortSpaceExhausted));
        };
        let position = next_position(&tx)?;

        tx.execute(
            "INSERT INTO apps (id, name, subtitle, enabled, position, provenance, local_only, client_id) \
             VALUES (?1, ?2, ?3, 1, ?4, 'self-hosted', 1, NULL)",
            params![slug, new.name, new.subtitle, position],
        )?;
        tx.execute(
            "INSERT INTO self_hosted_apps (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES (?1, ?2, ?4, ?1, 0, ?3)",
            params![slug, port, new.launch_path, new.content_folder],
        )?;
        let app = find_app_on(&tx, &slug)?.ok_or_else(|| {
            rusqlite::Error::QueryReturnedNoRows // unreachable: just inserted under this txn
        })?;
        tx.commit()?;
        Ok(Ok(app))
    }

    /// Replace a cloud app's *content*: the parent's `name` / `subtitle` and the
    /// child's `url` / `requires_tunnel`, in one transaction. **Never touches
    /// `enabled`** — that column has a single writer (`PUT /home-screen`).
    ///
    /// Returns `Ok(None)` when no cloud app has this id (the parent
    /// `UPDATE … WHERE id = ? AND provenance = 'cloud'` matched no row — an
    /// unknown or non-cloud id leaves everything untouched), else the updated
    /// whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn replace_cloud_content(&self, id: &str, content: &CloudContent) -> DbResult<Option<App>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;
        let parent_affected = tx.execute(
            "UPDATE apps SET name = ?2, subtitle = ?3 \
             WHERE id = ?1 AND provenance = 'cloud'",
            params![id, content.name, content.subtitle],
        )?;
        if parent_affected != 1 {
            // Not a cloud app (or no such id) — leave the child untouched.
            tx.rollback()?;
            return Ok(None);
        }
        tx.execute(
            "UPDATE cloud_apps SET url = ?2, requires_tunnel = ?3 WHERE id = ?1",
            params![id, content.url, content.requires_tunnel],
        )?;
        let app = find_app_on(&tx, id)?;
        tx.commit()?;
        Ok(app)
    }

    /// Replace a self-hosted app's `launch_path` (see
    /// [`SelfHostedApp::launch_path`](crate::domain::SelfHostedApp::launch_path));
    /// `None` clears it back to root-serving. Returns `Ok(None)` when no
    /// self-hosted app has this id, else the updated whole [`App`] read back
    /// in-txn. The update handler enforces "not seeded" before calling this —
    /// it already holds the [`App`] and its `seeded` flag.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn replace_self_hosted_launch_path(
        &self,
        id: &str,
        launch_path: Option<&str>,
    ) -> DbResult<Option<App>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;
        let affected = tx.execute(
            "UPDATE self_hosted_apps SET launch_path = ?2 WHERE id = ?1",
            params![id, launch_path],
        )?;
        if affected != 1 {
            tx.rollback()?;
            return Ok(None);
        }
        let app = find_app_on(&tx, id)?;
        tx.commit()?;
        Ok(app)
    }

    /// Delete an app by id, any kind — the parent `DELETE` cascades to the
    /// `cloud_apps` / `self_hosted_apps` child (`ON DELETE CASCADE`). Returns
    /// `true` when a row was removed. The handlers enforce the removability
    /// policy (kind + seeded) before calling this; the upload handler also calls
    /// it to roll back a row whose staged files couldn't be moved into place.
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

    /// Atomically validate **and** rewrite the whole homescreen — the ordering
    /// **and** the `enabled` flags — in one transaction. The body must list every
    /// registry app exactly once; each `(id, enabled)` at index `i` sets that
    /// row's `position = i` and `enabled`. Returns the resulting catalogue in its
    /// new order (read inside the same transaction), or `Ok(None)` when `entries`
    /// isn't an exact permutation of the live registry — the caller maps that to
    /// `400 InvalidHomeScreen`.
    ///
    /// The sole writer of `position` / `enabled` across every kind, validating and
    /// renumbering under one transaction — see the single-writer section of
    /// `docs/Apps/Store and Install Explanation.md`.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn replace_home_screen(&self, entries: &[(String, bool)]) -> DbResult<Option<Vec<App>>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;

        // Validate against the live registry under the same lock/transaction as
        // the renumber: the body must be an exact permutation of the current ids.
        let current_ids: HashSet<String> = {
            let mut stmt = tx.prepare("SELECT id FROM apps")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<HashSet<String>>>()?
        };
        let body_ids: HashSet<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        let id_set_changed_since_submission = entries.len() != current_ids.len()
            || body_ids.len() != entries.len()
            || body_ids
                .iter()
                .any(|body_id| !current_ids.contains(*body_id));
        if id_set_changed_since_submission {
            // Drop the transaction without committing (rolls back); nothing was
            // written. The handler turns `None` into `400 InvalidHomeScreen`.
            return Ok(None);
        }

        {
            // Move every row to a disjoint negative range first so the per-row
            // renumber below never transiently violates `UNIQUE(position)`
            // (SQLite's UNIQUE is immediate, not deferrable).
            tx.execute("UPDATE apps SET position = -1 - position", [])?;
            // Prepared once and reused across rows (the block scopes it to drop
            // before `commit()` consumes the transaction).
            let mut update_app_statement =
                tx.prepare("UPDATE apps SET position = ?2, enabled = ?3 WHERE id = ?1")?;
            for (position, (id, enabled)) in entries.iter().enumerate() {
                let position = i64::try_from(position).expect("home-screen length fits i64");
                update_app_statement.execute(params![id, position, enabled])?;
            }
        }

        // Read the new catalogue inside the transaction so the response can't
        // reflect a write that landed after the renumber.
        let updated_app_list = list_apps_on(&tx)?;
        tx.commit()?;
        Ok(Some(updated_app_list))
    }
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry),
/// computed on the caller's open transaction so overlapping creates can't
/// both read the same value.
fn next_position(tx: &rusqlite::Transaction<'_>) -> DbResult<i64> {
    tx.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM apps",
        [],
        |row| row.get(0),
    )
}

/// The attempt-`N` slug candidate: the base itself first, then `{base}-{attempt}`,
/// kept a valid DNS label (≤ 63 chars, no trailing `-`) — the suffix is budgeted
/// first and the base truncated to fit. See the slug-allocation section of
/// `docs/Apps/Store and Install Explanation.md` for why the label limit matters.
/// The base is `slugify` output (ASCII), so char truncation is byte truncation.
fn slug_candidate(base: &str, attempt: u32) -> String {
    if attempt == 1 {
        return base.to_owned();
    }
    let suffix = format!("-{attempt}");
    let budget = 63 - suffix.len();
    let mut head: String = base.chars().take(budget).collect();
    // A cut can land right after a `-`; trim so the candidate never carries a
    // `--` run introduced by truncation (or a bare leading suffix).
    while head.ends_with('-') {
        head.pop();
    }
    format!("{head}{suffix}")
}

/// The **lowest** unallocated loopback port in `MIN_UPLOAD_PORT..=max_port`,
/// skipping ports already handed to other rows and `reserved_ports`. Lowest-free
/// (not `MAX+1`) reuses released ports to keep origins stable across reinstall —
/// see the port-allocation section of `docs/Apps/Store and Install Explanation.md`.
/// "Unallocated" is not a liveness check (only binding proves a port free). `None`
/// when the range is exhausted (`max_port` is parameterized only so tests can
/// reach that). Runs on the open transaction so it can't race a concurrent insert.
fn next_free_port(
    tx: &rusqlite::Transaction<'_>,
    reserved_ports: &[u16],
    max_port: u16,
) -> DbResult<Option<u16>> {
    let taken: HashSet<u16> = {
        let mut stmt = tx.prepare("SELECT port FROM self_hosted_apps")?;
        let rows = stmt.query_map([], |row| row.get::<_, u16>(0))?;
        rows.collect::<rusqlite::Result<HashSet<u16>>>()?
    };
    // Safe: MIN_UPLOAD_PORT is a small in-range constant.
    let floor = u16::try_from(MIN_UPLOAD_PORT).expect("MIN_UPLOAD_PORT fits u16");
    Ok((floor..=max_port)
        .find(|candidate| !taken.contains(candidate) && !reserved_ports.contains(candidate)))
}

#[cfg(test)]
mod tests {
    use crate::db::{AppsStore, CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};
    use crate::domain::{App, AppUrl, Provenance};

    fn cloud_content(name: &str, url: AppUrl) -> CloudContent {
        CloudContent {
            name: name.to_owned(),
            subtitle: None,
            url,
            requires_tunnel: false,
        }
    }

    fn new_cloud(id: &str, url: AppUrl) -> NewCloudApp {
        NewCloudApp {
            id: id.to_owned(),
            content: cloud_content(id, url),
        }
    }

    fn new_upload(name: &str, base_slug: &str) -> NewSelfHostedUpload {
        NewSelfHostedUpload {
            name: name.to_owned(),
            subtitle: None,
            base_slug: base_slug.to_owned(),
            // Deliberately NOT the slug — the store must record it verbatim.
            content_folder: format!("{base_slug}-folder"),
            reserved_ports: Vec::new(),
            launch_path: None,
        }
    }

    fn external(url: &str) -> AppUrl {
        AppUrl::External(url.to_owned())
    }

    #[test]
    fn insert_cloud_app_returns_the_whole_app_and_round_trips() {
        let store = AppsStore::open_in_memory().unwrap();
        let inserted = store
            .insert_cloud_app(&new_cloud("app-x", external("https://example.com/launch")))
            .unwrap()
            .expect("inserted");
        // The in-txn read-back and a fresh find agree exactly.
        assert_eq!(store.find_app("app-x").unwrap().as_ref(), Some(&inserted));
        assert_eq!(inserted.provenance(), Provenance::Cloud);
        // Appended after the six seeded rows (positions 0..=5), enabled, not
        // local-only, no client_id.
        assert_eq!(inserted.position, 6);
        assert!(inserted.enabled);
        assert!(!inserted.local_only);
        assert!(!inserted.smart(), "inserted cloud app has no client_id");
        let payload = inserted.as_cloud().expect("cloud payload");
        assert_eq!(payload.url, external("https://example.com/launch"));
        assert!(!payload.requires_tunnel);
    }

    #[test]
    fn insert_cloud_app_returns_none_on_duplicate_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let new = new_cloud("app-x", external("https://example.com/x"));
        assert!(store.insert_cloud_app(&new).unwrap().is_some());
        assert!(
            store.insert_cloud_app(&new).unwrap().is_none(),
            "second insert with the same id is a no-op",
        );
        // The first insert appended after the six seeded rows (0..=5); the failed
        // second insert left no orphan child and didn't move the position.
        assert_eq!(store.find_app("app-x").unwrap().unwrap().position, 6);
    }

    /// A seeded cloud app's id can't be re-created — the parent PK rejects it and
    /// the child insert never runs.
    #[test]
    fn insert_cloud_app_rejects_a_seeded_id_without_orphaning_a_child() {
        let store = AppsStore::open_in_memory().unwrap();
        let new = new_cloud("growth-chart", external("https://example.com/x"));
        assert!(store.insert_cloud_app(&new).unwrap().is_none());
        // The original child url is untouched.
        let fetched = store.find_app("growth-chart").unwrap().unwrap();
        assert!(fetched
            .as_cloud()
            .expect("cloud payload")
            .url
            .to_string()
            .contains("growth-chart-app"));
    }

    #[test]
    fn replace_cloud_content_writes_parent_and_child() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_cloud_app(&new_cloud("app-x", external("https://example.com/x")))
            .unwrap()
            .expect("inserted");

        let replaced = store
            .replace_cloud_content(
                "app-x",
                &CloudContent {
                    name: "Renamed".to_owned(),
                    subtitle: Some("the new subtitle".to_owned()),
                    url: AppUrl::OriginRelative("/path".to_owned()),
                    requires_tunnel: true,
                },
            )
            .unwrap()
            .expect("replaced");
        assert_eq!(replaced.name, "Renamed");
        assert_eq!(replaced.subtitle.as_deref(), Some("the new subtitle"));
        let payload = replaced.as_cloud().expect("cloud payload");
        assert_eq!(payload.url, AppUrl::OriginRelative("/path".to_owned()));
        assert!(payload.requires_tunnel);
        // A fresh read agrees with the in-txn read-back.
        assert_eq!(store.find_app("app-x").unwrap().as_ref(), Some(&replaced));
    }

    /// A content replace must not touch `enabled` — `PUT /home-screen` is that
    /// column's single writer. Disable an app through the home screen, replace
    /// its content, and it must stay disabled.
    #[test]
    fn replace_cloud_content_leaves_enabled_alone() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_cloud_app(&new_cloud("app-x", external("https://example.com/x")))
            .unwrap()
            .expect("inserted");

        // Disable app-x via the home-screen writer (an identity reorder).
        let entries: Vec<(String, bool)> = store
            .list_apps()
            .unwrap()
            .iter()
            .map(|app| (app.id.clone(), app.id != "app-x"))
            .collect();
        store
            .replace_home_screen(&entries)
            .unwrap()
            .expect("permutation");
        assert!(!store.find_app("app-x").unwrap().unwrap().enabled);

        let replaced = store
            .replace_cloud_content(
                "app-x",
                &cloud_content("Renamed", external("https://example.com/y")),
            )
            .unwrap()
            .expect("replaced");
        assert!(
            !replaced.enabled,
            "a content replace must not re-enable a disabled app",
        );
    }

    /// `replace_cloud_content` only touches cloud apps — a self-hosted / system
    /// id is a no-op `None`, and crucially does NOT mutate the parent row.
    #[test]
    fn replace_cloud_content_ignores_non_cloud_ids() {
        let store = AppsStore::open_in_memory().unwrap();
        // patient-browser is self-hosted; api-docs is system.
        for id in ["patient-browser", "api-docs"] {
            let replaced = store
                .replace_cloud_content(
                    id,
                    &cloud_content(id, external("https://example.com/tampered")),
                )
                .unwrap();
            assert!(replaced.is_none(), "{id} is not a cloud app");
            // Its parent name is unchanged.
            let parent = store.find_app(id).unwrap().unwrap();
            assert_ne!(parent.name, id, "{id} parent row must be untouched");
        }
    }

    #[test]
    fn replace_cloud_content_returns_none_for_unknown_id() {
        let store = AppsStore::open_in_memory().unwrap();
        assert!(store
            .replace_cloud_content(
                "ghost",
                &cloud_content("ghost", external("https://x.example"))
            )
            .unwrap()
            .is_none());
    }

    /// An inserted upload lands one port above the seed (8081 → 8082), appends at
    /// the next position (after the six seeded rows → 6), and is flagged
    /// non-seeded (hence removable).
    #[test]
    fn insert_self_hosted_allocates_the_next_port_and_position() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = store
            .insert_self_hosted_app(&new_upload("My App", "my-app"))
            .unwrap()
            .expect("inserted");
        assert_eq!(app.id, "my-app");
        assert_eq!(app.name, "My App");
        assert_eq!(app.position, 6);
        assert!(app.local_only);
        assert!(app.enabled);
        assert_eq!(app.provenance(), Provenance::SelfHosted);
        let payload = app.as_self_hosted().expect("self-hosted payload");
        assert_eq!(payload.port, 8082);
        assert_eq!(
            payload.content_folder, "my-app-folder",
            "content_folder is recorded verbatim from the spec, not the slug",
        );
        assert_eq!(payload.subdomain, "my-app");
        assert!(!payload.seeded);

        // A second upload takes the next port and position.
        let app2 = store
            .insert_self_hosted_app(&new_upload("Other", "other"))
            .unwrap()
            .expect("inserted");
        assert_eq!(app2.as_self_hosted().unwrap().port, 8083);
        assert_eq!(app2.position, 7);
    }

    /// A `launch_path` supplied at insert round-trips through both the insert
    /// return and a fresh `find`; an app inserted without one reads back `None`.
    #[test]
    fn insert_self_hosted_persists_and_reads_back_the_launch_path() {
        let store = AppsStore::open_in_memory().unwrap();
        let template = "/launch.html?launch={launch}&iss={origin}/fhir-r4";
        let mut upload = new_upload("Launcher", "launcher");
        upload.launch_path = Some(template.to_owned());
        let inserted = store
            .insert_self_hosted_app(&upload)
            .unwrap()
            .expect("inserted");
        let launch_path = |app: &App| app.as_self_hosted().unwrap().launch_path.clone();
        assert_eq!(launch_path(&inserted).as_deref(), Some(template));

        let found = store.find_app("launcher").unwrap().expect("found");
        assert_eq!(launch_path(&found).as_deref(), Some(template));

        let rootless = store
            .insert_self_hosted_app(&new_upload("Rootless", "rootless"))
            .unwrap()
            .expect("inserted");
        assert_eq!(launch_path(&rootless), None);
    }

    /// `replace_self_hosted_launch_path` sets, replaces, and clears the column;
    /// an unknown id matches nothing.
    #[test]
    fn replace_launch_path_sets_replaces_and_clears() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_self_hosted_app(&new_upload("App", "app"))
            .unwrap()
            .expect("inserted");
        let launch_path = |app: App| app.as_self_hosted().unwrap().launch_path.clone();

        let set = store
            .replace_self_hosted_launch_path("app", Some("/launch.html"))
            .unwrap()
            .expect("updated");
        assert_eq!(launch_path(set).as_deref(), Some("/launch.html"));

        let cleared = store
            .replace_self_hosted_launch_path("app", None)
            .unwrap()
            .expect("updated");
        assert_eq!(launch_path(cleared), None);

        assert!(
            store
                .replace_self_hosted_launch_path("ghost", Some("/x"))
                .unwrap()
                .is_none(),
            "an unknown id matches no row",
        );
    }

    /// A reserved port (the host loopback port) is skipped in the allocation.
    #[test]
    fn insert_self_hosted_skips_reserved_ports() {
        let store = AppsStore::open_in_memory().unwrap();
        // 8082 would be next, but it's reserved → 8083.
        let mut upload = new_upload("My App", "my-app");
        upload.reserved_ports = vec![8082];
        let app = store
            .insert_self_hosted_app(&upload)
            .unwrap()
            .expect("inserted");
        assert_eq!(app.as_self_hosted().unwrap().port, 8083);
    }

    /// The suffixed candidate is capped at the 63-char DNS label limit — the
    /// slug is stored verbatim as the public subdomain, so an over-long label
    /// would break `<subdomain>.<public_host>` routing.
    #[test]
    fn suffixed_slug_stays_a_valid_dns_label() {
        let store = AppsStore::open_in_memory().unwrap();
        let base = "a".repeat(63); // slugify's cap: a full-length label
        let first = store
            .insert_self_hosted_app(&new_upload("Long", &base))
            .unwrap()
            .expect("inserted");
        assert_eq!(first.id.len(), 63);

        let second = store
            .insert_self_hosted_app(&new_upload("Long", &base))
            .unwrap()
            .expect("inserted");
        assert!(
            second.id.len() <= 63,
            "the suffixed slug must stay within the DNS label limit: {} ({} chars)",
            second.id,
            second.id.len(),
        );
        assert!(second.id.ends_with("-2"), "id: {}", second.id);
        assert_ne!(first.id, second.id);
        assert_eq!(
            second.as_self_hosted().unwrap().subdomain,
            second.id,
            "the capped slug is the subdomain",
        );
    }

    /// Exhausting the suffix-attempt budget is reported as
    /// `SlugSpaceExhausted` — distinct from port exhaustion, so the handler
    /// can keep answering "pick another name".
    #[test]
    fn slug_space_exhaustion_is_reported_distinctly() {
        let store = AppsStore::open_in_memory().unwrap();
        let upload_n = |n: u32| {
            let mut upload = new_upload("Crowded", "crowded");
            // Each row needs its own folder value; uniqueness isn't enforced on
            // the column, but keep the fixture honest.
            upload.content_folder = format!("crowded-folder-{n}");
            upload
        };
        // Fill the whole candidate space: `crowded`, `crowded-2` … `crowded-50`.
        for n in 0..50 {
            store
                .insert_self_hosted_app(&upload_n(n))
                .unwrap()
                .expect("inserted");
        }
        assert_eq!(
            store.insert_self_hosted_app(&upload_n(50)).unwrap(),
            Err(UploadInsertError::SlugSpaceExhausted),
        );
    }

    /// A freed port is reused (lowest-free allocation), so a delete →
    /// reinstall cycle lands back on its original loopback origin instead of
    /// drifting upward forever.
    #[test]
    fn freed_ports_are_reused_lowest_first() {
        let store = AppsStore::open_in_memory().unwrap();
        let first = store
            .insert_self_hosted_app(&new_upload("First", "first"))
            .unwrap()
            .expect("inserted");
        let second = store
            .insert_self_hosted_app(&new_upload("Second", "second"))
            .unwrap()
            .expect("inserted");
        assert_eq!(first.as_self_hosted().unwrap().port, 8082);
        assert_eq!(second.as_self_hosted().unwrap().port, 8083);

        assert!(store.delete_app("first").unwrap());
        let third = store
            .insert_self_hosted_app(&new_upload("Third", "third"))
            .unwrap()
            .expect("inserted");
        assert_eq!(
            third.as_self_hosted().unwrap().port,
            8082,
            "the freed port must be reused, not MAX+1",
        );
    }

    /// `next_free_port` returns `None` only when every port in range is taken
    /// or reserved — exercised with a tiny ceiling since the real range is
    /// practically inexhaustible.
    #[test]
    fn next_free_port_reports_exhaustion() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_self_hosted_app(&new_upload("Taken", "taken"))
            .unwrap()
            .expect("inserted"); // occupies 8082
        let guard = store.conn().lock();
        let tx = guard.unchecked_transaction().unwrap();
        assert_eq!(
            super::next_free_port(&tx, &[8083], 8083).unwrap(),
            None,
            "8082 taken + 8083 reserved exhausts a ceiling of 8083",
        );
        assert_eq!(
            super::next_free_port(&tx, &[8083], 8084).unwrap(),
            Some(8084),
            "one more port in range frees the allocation",
        );
    }

    /// A base slug colliding with the seeded `patient-browser` is suffixed `-2`.
    #[test]
    fn insert_self_hosted_suffixes_a_colliding_slug() {
        let store = AppsStore::open_in_memory().unwrap();
        let upload = new_upload("Patient Browser", "patient-browser");
        let app = store
            .insert_self_hosted_app(&upload)
            .unwrap()
            .expect("inserted");
        assert_eq!(app.id, "patient-browser-2");
        let payload = app.as_self_hosted().unwrap();
        assert_eq!(payload.subdomain, "patient-browser-2");
        assert_eq!(
            payload.content_folder, "patient-browser-folder",
            "the slug suffix must not leak into the caller-owned content_folder",
        );

        // A third with the same base skips to `-3`.
        let app3 = store
            .insert_self_hosted_app(&upload)
            .unwrap()
            .expect("inserted");
        assert_eq!(app3.id, "patient-browser-3");
    }

    /// Delete removes both the parent and the child (CASCADE), for either kind.
    #[test]
    fn delete_app_cascades_to_the_child() {
        let store = AppsStore::open_in_memory().unwrap();

        // An uploaded self-hosted app.
        let app = store
            .insert_self_hosted_app(&new_upload("My App", "my-app"))
            .unwrap()
            .expect("inserted");
        assert!(store.delete_app(&app.id).unwrap());
        assert!(store.find_app("my-app").unwrap().is_none());
        assert!(
            !store.delete_app("my-app").unwrap(),
            "a second delete of the same id removes nothing",
        );

        // A seeded cloud app: the child row is gone too (CASCADE).
        assert!(store.delete_app("growth-chart").unwrap());
        assert!(store.find_app("growth-chart").unwrap().is_none());
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

        assert!(!store.delete_app("no-such-id").unwrap());
    }

    /// The removability matrix over live rows: cloud + uploaded self-hosted are
    /// removable; system + seeded self-hosted are not.
    #[test]
    fn removable_per_kind_and_seeded_on_live_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_self_hosted_app(&new_upload("My App", "my-app"))
            .unwrap()
            .expect("inserted");
        let apps = store.list_apps().unwrap();
        let by_id = |id: &str| apps.iter().find(|a| a.id == id).expect("row");
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

    /// `replace_home_screen` renumbers every row to its array index and applies
    /// each `enabled` flag, in one shot, for any kind — and leaves the positions
    /// a dense `0..n` permutation (no ties). Reversing the seed (every row
    /// changes position) also exercises the `UNIQUE(position)` collision-free
    /// renumber.
    #[test]
    fn replace_home_screen_renumbers_and_sets_enabled_for_any_kind() {
        let store = AppsStore::open_in_memory().unwrap();
        // Reverse the seeded order, disabling a system app (api-docs) along the way.
        let entries: Vec<(String, bool)> = vec![
            ("precise-hbr".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("api-docs".to_owned(), false),
            ("api-view".to_owned(), true),
            ("patient-browser".to_owned(), true),
        ];
        let updated = store
            .replace_home_screen(&entries)
            .unwrap()
            .expect("an exact permutation renumbers and returns the catalogue");

        // The returned catalogue is in the new order.
        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|a| a.id.clone()).collect();
        assert_eq!(returned_ids, expected);

        // Positions are exactly the array indices (dense 0..n, no duplicates).
        for (position, (id, _)) in entries.iter().enumerate() {
            let app = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                app.position,
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        // The enabled flag was applied (api-docs is a system app — not gated).
        assert!(!store.find_app("api-docs").unwrap().unwrap().enabled);
        // A follow-up list read agrees with the order returned inside the txn.
        let ids: Vec<String> = store
            .list_apps()
            .unwrap()
            .iter()
            .map(|a| a.id.clone())
            .collect();
        assert_eq!(ids, expected);
    }

    /// A body that isn't an exact permutation of the live registry returns
    /// `Ok(None)` (→ `400`) and writes nothing — validation happens inside the
    /// same transaction as the renumber.
    #[test]
    fn replace_home_screen_rejects_a_non_permutation_without_writing() {
        let store = AppsStore::open_in_memory().unwrap();
        let ids_now = |store: &AppsStore| -> Vec<String> {
            store
                .list_apps()
                .unwrap()
                .iter()
                .map(|a| a.id.clone())
                .collect()
        };
        let before = ids_now(&store);

        // A subset (missing rows) — not a permutation.
        let subset = vec![("api-view".to_owned(), true), ("api-docs".to_owned(), true)];
        assert!(store.replace_home_screen(&subset).unwrap().is_none());

        // A full-length body with a duplicated id (and a missing one) — also not
        // a permutation.
        let dup = vec![
            ("patient-browser".to_owned(), true),
            ("api-view".to_owned(), true),
            ("api-docs".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("api-view".to_owned(), true),
        ];
        assert!(store.replace_home_screen(&dup).unwrap().is_none());

        // The registry order is untouched.
        assert_eq!(
            before,
            ids_now(&store),
            "a rejected body must not reorder anything"
        );
    }
}

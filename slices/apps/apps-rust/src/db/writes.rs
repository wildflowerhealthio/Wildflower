//! The store's write side. Every mutator is a **single-kind** write: it hits one
//! concrete table (`cloud_apps` or `self_hosted_apps`) plus, on create/delete, the
//! shared `home_screen` ordering table — never a cross-*kind* transaction. Each
//! takes a [`write_inputs`](super::write_inputs) spec rather than loose scalars,
//! and — for create / replace — returns the hydrated [`App`] re-read *inside the
//! same transaction* (via [`find_app_on`](super::reads::find_app_on)). The
//! transaction discipline is explained in
//! `docs/Apps/Store and Install Explanation.md` §"Transaction discipline".

use std::collections::HashSet;

use diesel::prelude::*;

use super::reads::{
    delete_app_rows, find_app_on, id_taken, insert_home_screen_row, list_apps_on, next_position,
};
use super::schema::{cloud_apps, home_screen, self_hosted_apps};
use super::write_inputs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};
use super::AppsStore;
use crate::domain::{App, AppError, CloudApp, SelfHostedApp};

/// The smallest loopback port an uploaded app is allocated — one above the seeded
/// patient-browser at 8081. See the port-allocation section of
/// `docs/Apps/Store and Install Explanation.md`.
const MIN_UPLOAD_PORT: i64 = 8082;

/// Attempts at suffixing a base slug (`-2`, `-3`, …) before reporting
/// [`UploadInsertError::SlugSpaceExhausted`].
const MAX_SLUG_ATTEMPTS: u32 = 50;

impl AppsStore {
    /// Insert a fresh cloud app: the `cloud_apps` row (not local-only, no
    /// `client_id`) AND its `home_screen` row (next position, enabled), in one
    /// transaction, appended at the tail.
    ///
    /// Returns `Ok(None)` when the id is already taken (no row is written), else
    /// the inserted whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] on a checkout / transaction failure.
    pub fn insert_cloud_app(&self, new: &NewCloudApp) -> Result<Option<App>, AppError> {
        let mut conn = self.checkout()?;
        conn.transaction(|conn| {
            if id_taken(conn, &new.id)? {
                return Ok(None);
            }
            let position = next_position(conn)?;
            diesel::insert_into(cloud_apps::table)
                .values(CloudApp {
                    id: new.id.clone(),
                    name: new.content.name.clone(),
                    subtitle: new.content.subtitle.clone(),
                    local_only: false,
                    client_id: None,
                    url: new.content.url.clone(),
                    requires_tunnel: new.content.requires_tunnel,
                })
                .execute(conn)?;
            insert_home_screen_row(conn, &new.id, position)?;
            find_app_on(conn, &new.id)
        })
    }

    /// Insert a fresh uploaded self-hosted app: the `self_hosted_apps` row
    /// (`seeded = 0`, `local_only = 1`) AND its `home_screen` row, in one
    /// transaction. The final slug (unique against both the global id space and
    /// the `self_hosted_apps.subdomain` space, kept a valid DNS label — see
    /// [`slug_candidate`]) becomes the row's `id` and `subdomain`; the
    /// [`content_folder`](NewSelfHostedUpload::content_folder) is recorded
    /// verbatim. The port is the lowest free one from [`next_free_port`]. Slug,
    /// port, and position are all allocated **inside** the transaction.
    ///
    /// Returns `Ok(Err(_))` — nothing written — when the slug attempts or the port
    /// space are exhausted; otherwise the inserted whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] on a checkout / transaction failure.
    pub fn insert_self_hosted_app(
        &self,
        new: &NewSelfHostedUpload,
    ) -> Result<Result<App, UploadInsertError>, AppError> {
        let mut conn = self.checkout()?;
        conn.transaction(|conn| {
            // Find a slug free of both the global id space and the subdomain space.
            let mut chosen_slug = None;
            for attempt in 1..=MAX_SLUG_ATTEMPTS {
                let candidate = slug_candidate(&new.base_slug, attempt);
                if !id_taken(conn, &candidate)? && !subdomain_taken(conn, &candidate)? {
                    chosen_slug = Some(candidate);
                    break;
                }
            }
            let Some(slug) = chosen_slug else {
                return Ok(Err(UploadInsertError::SlugSpaceExhausted));
            };

            let Some(port) = next_free_port(conn, &new.reserved_ports, u16::MAX)? else {
                return Ok(Err(UploadInsertError::PortSpaceExhausted));
            };
            let position = next_position(conn)?;

            diesel::insert_into(self_hosted_apps::table)
                .values(SelfHostedApp {
                    id: slug.clone(),
                    name: new.name.clone(),
                    subtitle: new.subtitle.clone(),
                    local_only: true,
                    client_id: None,
                    port,
                    content_folder: new.content_folder.clone(),
                    subdomain: slug.clone(),
                    seeded: false,
                    launch_path: new.launch_path.clone(),
                })
                .execute(conn)?;
            insert_home_screen_row(conn, &slug, position)?;
            let app = find_app_on(conn, &slug)?.ok_or_else(|| {
                AppError::backend("insert_self_hosted_app", "row vanished after insert")
            })?;
            Ok(Ok(app))
        })
    }

    /// Replace a cloud app's *content*: `name` / `subtitle` / `url` /
    /// `requires_tunnel` on the `cloud_apps` row. **Never touches `enabled` /
    /// position** — those live in `home_screen`, whose single writer is
    /// `PUT /home-screen`.
    ///
    /// Returns `Ok(None)` when no cloud app has this id (a non-cloud or unknown id
    /// matches no `cloud_apps` row), else the updated whole [`App`] read back
    /// in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] on a checkout / transaction failure.
    pub fn replace_cloud_content(
        &self,
        id: &str,
        content: &CloudContent,
    ) -> Result<Option<App>, AppError> {
        let mut conn = self.checkout()?;
        conn.transaction(|conn| {
            let affected = diesel::update(cloud_apps::table.find(id))
                .set((
                    cloud_apps::name.eq(&content.name),
                    cloud_apps::subtitle.eq(&content.subtitle),
                    cloud_apps::url.eq(content.url.to_string()),
                    cloud_apps::requires_tunnel.eq(content.requires_tunnel),
                ))
                .execute(conn)?;
            if affected != 1 {
                return Ok(None);
            }
            find_app_on(conn, id)
        })
    }

    /// Replace a self-hosted app's `launch_path`; `None` clears it back to
    /// root-serving. Returns `Ok(None)` when no self-hosted app has this id, else
    /// the updated whole [`App`] read back in-txn. The update handler enforces
    /// "not seeded" before calling this.
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] on a checkout / transaction failure.
    pub fn replace_self_hosted_launch_path(
        &self,
        id: &str,
        launch_path: Option<&str>,
    ) -> Result<Option<App>, AppError> {
        let mut conn = self.checkout()?;
        conn.transaction(|conn| {
            let affected = diesel::update(self_hosted_apps::table.find(id))
                .set(self_hosted_apps::launch_path.eq(launch_path))
                .execute(conn)?;
            if affected != 1 {
                return Ok(None);
            }
            find_app_on(conn, id)
        })
    }

    /// Delete an app by id, any kind — its `home_screen` row plus its concrete row.
    /// Returns `true` when a row was removed. The handlers enforce the removability
    /// policy (kind + seeded) before calling this.
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] on a checkout / transaction failure.
    pub fn delete_app(&self, id: &str) -> Result<bool, AppError> {
        let mut conn = self.checkout()?;
        conn.transaction(|conn| delete_app_rows(conn, id))
    }

    /// Atomically validate **and** rewrite the whole homescreen — the ordering
    /// **and** the `enabled` flags — in one transaction over `home_screen`. The
    /// body must list every registry app exactly once; each `(id, enabled)` at
    /// index `i` sets that row's `position = i` and `enabled`. Returns the
    /// resulting catalogue in its new order (read inside the same transaction), or
    /// `Ok(None)` when `entries` isn't an exact permutation of the live registry —
    /// the caller maps that to `400 InvalidHomeScreen`.
    ///
    /// The sole writer of `position` / `enabled` across every kind. See the
    /// single-writer section of `docs/Apps/Store and Install Explanation.md`.
    ///
    /// # Errors
    ///
    /// [`AppError::Backend`] on a checkout / transaction failure.
    pub fn replace_home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<App>>, AppError> {
        let mut conn = self.checkout()?;
        conn.transaction(|conn| {
            // Validate against the live registry under the same transaction as the
            // renumber: the body must be an exact permutation of the current ids
            // (`home_screen` carries one row per app of every kind).
            let current_ids: HashSet<String> = home_screen::table
                .select(home_screen::app_id)
                .load::<String>(conn)?
                .into_iter()
                .collect();
            let body_ids: HashSet<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
            let id_set_changed_since_submission = entries.len() != current_ids.len()
                || body_ids.len() != entries.len()
                || body_ids
                    .iter()
                    .any(|body_id| !current_ids.contains(*body_id));
            if id_set_changed_since_submission {
                return Ok(None);
            }

            // Move every row to a disjoint negative range first so the per-row
            // renumber below never transiently violates `UNIQUE(position)`
            // (SQLite's UNIQUE is immediate, not deferrable).
            diesel::sql_query("UPDATE home_screen SET position = -1 - position").execute(conn)?;
            for (position, (id, enabled)) in entries.iter().enumerate() {
                let position = i64::try_from(position).expect("home-screen length fits i64");
                diesel::update(home_screen::table.find(id))
                    .set((
                        home_screen::position.eq(position),
                        home_screen::enabled.eq(enabled),
                    ))
                    .execute(conn)?;
            }

            // Read the new catalogue inside the transaction so the response can't
            // reflect a write that landed after the renumber.
            let updated = list_apps_on(conn)?;
            Ok(Some(updated))
        })
    }
}

/// Whether any self-hosted app already uses this subdomain label.
fn subdomain_taken(conn: &mut SqliteConnection, subdomain: &str) -> Result<bool, AppError> {
    let taken = diesel::select(diesel::dsl::exists(
        self_hosted_apps::table.filter(self_hosted_apps::subdomain.eq(subdomain)),
    ))
    .get_result::<bool>(conn)?;
    Ok(taken)
}

/// The attempt-`N` slug candidate: the base itself first, then `{base}-{attempt}`,
/// kept a valid DNS label (≤ 63 chars, no trailing `-`) — the suffix is budgeted
/// first and the base truncated to fit. The base is `slugify` output (ASCII), so
/// char truncation is byte truncation.
fn slug_candidate(base: &str, attempt: u32) -> String {
    if attempt == 1 {
        return base.to_owned();
    }
    let suffix = format!("-{attempt}");
    let budget = 63 - suffix.len();
    let mut head: String = base.chars().take(budget).collect();
    while head.ends_with('-') {
        head.pop();
    }
    format!("{head}{suffix}")
}

/// The **lowest** unallocated loopback port in `MIN_UPLOAD_PORT..=max_port`,
/// skipping ports already handed to other rows and `reserved_ports`. Lowest-free
/// (not `MAX+1`) reuses released ports to keep origins stable across reinstall.
/// `None` when the range is exhausted (`max_port` is parameterized only so tests
/// can reach that). Runs on the open transaction so it can't race a concurrent
/// insert.
fn next_free_port(
    conn: &mut SqliteConnection,
    reserved_ports: &[u16],
    max_port: u16,
) -> Result<Option<u16>, AppError> {
    let taken: HashSet<u16> = self_hosted_apps::table
        .select(self_hosted_apps::port)
        .load::<i32>(conn)?
        .into_iter()
        .filter_map(|p| u16::try_from(p).ok())
        .collect();
    let floor = u16::try_from(MIN_UPLOAD_PORT).expect("MIN_UPLOAD_PORT fits u16");
    Ok((floor..=max_port)
        .find(|candidate| !taken.contains(candidate) && !reserved_ports.contains(candidate)))
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

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
        assert_eq!(store.find_app("app-x").unwrap().as_ref(), Some(&inserted));
        assert_eq!(inserted.provenance(), Provenance::Cloud);
        assert_eq!(inserted.position(), 6);
        assert!(inserted.enabled());
        assert!(!inserted.local_only());
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
        assert_eq!(store.find_app("app-x").unwrap().unwrap().position(), 6);
    }

    /// A seeded app's id can't be re-created — `home_screen` already holds it, so
    /// the insert is a no-op `None` and the original row is untouched.
    #[test]
    fn insert_cloud_app_rejects_a_seeded_id() {
        let store = AppsStore::open_in_memory().unwrap();
        let new = new_cloud("growth-chart", external("https://example.com/x"));
        assert!(store.insert_cloud_app(&new).unwrap().is_none());
        let fetched = store.find_app("growth-chart").unwrap().unwrap();
        assert!(fetched
            .as_cloud()
            .expect("cloud payload")
            .url
            .to_string()
            .contains("growth-chart-app"));
    }

    #[test]
    fn replace_cloud_content_writes_the_row() {
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
        assert_eq!(replaced.name(), "Renamed");
        assert_eq!(replaced.subtitle(), Some("the new subtitle"));
        let payload = replaced.as_cloud().expect("cloud payload");
        assert_eq!(payload.url, AppUrl::OriginRelative("/path".to_owned()));
        assert!(payload.requires_tunnel);
        assert_eq!(store.find_app("app-x").unwrap().as_ref(), Some(&replaced));
    }

    /// A content replace must not touch `enabled` — `PUT /home-screen` is that
    /// flag's single writer.
    #[test]
    fn replace_cloud_content_leaves_enabled_alone() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_cloud_app(&new_cloud("app-x", external("https://example.com/x")))
            .unwrap()
            .expect("inserted");

        let entries: Vec<(String, bool)> = store
            .list_apps()
            .unwrap()
            .iter()
            .map(|app| (app.id().to_owned(), app.id() != "app-x"))
            .collect();
        store
            .replace_home_screen(&entries)
            .unwrap()
            .expect("permutation");
        assert!(!store.find_app("app-x").unwrap().unwrap().enabled());

        let replaced = store
            .replace_cloud_content(
                "app-x",
                &cloud_content("Renamed", external("https://example.com/y")),
            )
            .unwrap()
            .expect("replaced");
        assert!(
            !replaced.enabled(),
            "a content replace must not re-enable a disabled app",
        );
    }

    /// `replace_cloud_content` only touches cloud apps — a self-hosted / system id
    /// is a no-op `None`, and does NOT mutate anything.
    #[test]
    fn replace_cloud_content_ignores_non_cloud_ids() {
        let store = AppsStore::open_in_memory().unwrap();
        for id in ["patient-browser", "api-docs"] {
            let replaced = store
                .replace_cloud_content(
                    id,
                    &cloud_content(id, external("https://example.com/tampered")),
                )
                .unwrap();
            assert!(replaced.is_none(), "{id} is not a cloud app");
            let row = store.find_app(id).unwrap().unwrap();
            assert_ne!(row.name(), id, "{id} row must be untouched");
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
    /// the next position (after the six seeded rows → 6), and is non-seeded.
    #[test]
    fn insert_self_hosted_allocates_the_next_port_and_position() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = store
            .insert_self_hosted_app(&new_upload("My App", "my-app"))
            .unwrap()
            .expect("inserted");
        assert_eq!(app.id(), "my-app");
        assert_eq!(app.name(), "My App");
        assert_eq!(app.position(), 6);
        assert!(app.local_only());
        assert!(app.enabled());
        assert_eq!(app.provenance(), Provenance::SelfHosted);
        let payload = app.as_self_hosted().expect("self-hosted payload");
        assert_eq!(payload.port, 8082);
        assert_eq!(
            payload.content_folder, "my-app-folder",
            "content_folder is recorded verbatim from the spec, not the slug",
        );
        assert_eq!(payload.subdomain, "my-app");
        assert!(!payload.seeded);

        let app2 = store
            .insert_self_hosted_app(&new_upload("Other", "other"))
            .unwrap()
            .expect("inserted");
        assert_eq!(app2.as_self_hosted().unwrap().port, 8083);
        assert_eq!(app2.position(), 7);
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
        let mut upload = new_upload("My App", "my-app");
        upload.reserved_ports = vec![8082];
        let app = store
            .insert_self_hosted_app(&upload)
            .unwrap()
            .expect("inserted");
        assert_eq!(app.as_self_hosted().unwrap().port, 8083);
    }

    /// The suffixed candidate is capped at the 63-char DNS label limit.
    #[test]
    fn suffixed_slug_stays_a_valid_dns_label() {
        let store = AppsStore::open_in_memory().unwrap();
        let base = "a".repeat(63);
        let first = store
            .insert_self_hosted_app(&new_upload("Long", &base))
            .unwrap()
            .expect("inserted");
        assert_eq!(first.id().len(), 63);

        let second = store
            .insert_self_hosted_app(&new_upload("Long", &base))
            .unwrap()
            .expect("inserted");
        assert!(
            second.id().len() <= 63,
            "the suffixed slug must stay within the DNS label limit: {} ({} chars)",
            second.id(),
            second.id().len(),
        );
        assert!(second.id().ends_with("-2"), "id: {}", second.id());
        assert_ne!(first.id(), second.id());
        assert_eq!(
            second.as_self_hosted().unwrap().subdomain,
            second.id(),
            "the capped slug is the subdomain",
        );
    }

    /// Exhausting the suffix-attempt budget is reported as `SlugSpaceExhausted`.
    #[test]
    fn slug_space_exhaustion_is_reported_distinctly() {
        let store = AppsStore::open_in_memory().unwrap();
        let upload_n = |n: u32| {
            let mut upload = new_upload("Crowded", "crowded");
            upload.content_folder = format!("crowded-folder-{n}");
            upload
        };
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

    /// A freed port is reused (lowest-free allocation).
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

    /// `next_free_port` returns `None` only when every port in range is taken or
    /// reserved — exercised with a tiny ceiling.
    #[test]
    fn next_free_port_reports_exhaustion() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .insert_self_hosted_app(&new_upload("Taken", "taken"))
            .unwrap()
            .expect("inserted"); // occupies 8082
        let mut conn = store.pool().get().unwrap();
        assert_eq!(
            super::next_free_port(&mut conn, &[8083], 8083).unwrap(),
            None,
            "8082 taken + 8083 reserved exhausts a ceiling of 8083",
        );
        assert_eq!(
            super::next_free_port(&mut conn, &[8083], 8084).unwrap(),
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
        assert_eq!(app.id(), "patient-browser-2");
        let payload = app.as_self_hosted().unwrap();
        assert_eq!(payload.subdomain, "patient-browser-2");
        assert_eq!(
            payload.content_folder, "patient-browser-folder",
            "the slug suffix must not leak into the caller-owned content_folder",
        );

        let app3 = store
            .insert_self_hosted_app(&upload)
            .unwrap()
            .expect("inserted");
        assert_eq!(app3.id(), "patient-browser-3");
    }

    /// Delete removes the `home_screen` row and the concrete row, for either kind.
    #[test]
    fn delete_app_removes_home_screen_and_concrete_rows() {
        let store = AppsStore::open_in_memory().unwrap();

        let app = store
            .insert_self_hosted_app(&new_upload("My App", "my-app"))
            .unwrap()
            .expect("inserted");
        assert!(store.delete_app(app.id()).unwrap());
        assert!(store.find_app("my-app").unwrap().is_none());
        assert!(
            !store.delete_app("my-app").unwrap(),
            "a second delete of the same id removes nothing",
        );

        assert!(store.delete_app("growth-chart").unwrap());
        assert!(store.find_app("growth-chart").unwrap().is_none());
        let mut conn = store.pool().get().unwrap();
        let child_count: i64 = super::cloud_apps::table
            .filter(super::cloud_apps::id.eq("growth-chart"))
            .count()
            .get_result(&mut conn)
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
        let by_id = |id: &str| apps.iter().find(|a| a.id() == id).expect("row");
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
    /// each `enabled` flag, in one shot, for any kind — leaving a dense `0..n`
    /// permutation (no ties).
    #[test]
    fn replace_home_screen_renumbers_and_sets_enabled_for_any_kind() {
        let store = AppsStore::open_in_memory().unwrap();
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

        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|a| a.id().to_owned()).collect();
        assert_eq!(returned_ids, expected);

        for (position, (id, _)) in entries.iter().enumerate() {
            let app = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                app.position(),
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        assert!(!store.find_app("api-docs").unwrap().unwrap().enabled());
        let ids: Vec<String> = store
            .list_apps()
            .unwrap()
            .iter()
            .map(|a| a.id().to_owned())
            .collect();
        assert_eq!(ids, expected);
    }

    /// A body that isn't an exact permutation of the live registry returns
    /// `Ok(None)` (→ `400`) and writes nothing.
    #[test]
    fn replace_home_screen_rejects_a_non_permutation_without_writing() {
        let store = AppsStore::open_in_memory().unwrap();
        let ids_now = |store: &AppsStore| -> Vec<String> {
            store
                .list_apps()
                .unwrap()
                .iter()
                .map(|a| a.id().to_owned())
                .collect()
        };
        let before = ids_now(&store);

        let subset = vec![("api-view".to_owned(), true), ("api-docs".to_owned(), true)];
        assert!(store.replace_home_screen(&subset).unwrap().is_none());

        let dup = vec![
            ("patient-browser".to_owned(), true),
            ("api-view".to_owned(), true),
            ("api-docs".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("api-view".to_owned(), true),
        ];
        assert!(store.replace_home_screen(&dup).unwrap().is_none());

        assert_eq!(
            before,
            ids_now(&store),
            "a rejected body must not reorder anything"
        );
    }
}

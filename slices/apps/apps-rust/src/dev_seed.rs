//! Debug-only seeding of the `…-dev` app rows that point at the first-party
//! apps' local vite dev servers.
//!
//! The two first-party apps (Medications, Web Trace) ship as **cloud** rows
//! served from <https://wildflower-health.io> (apps migration
//! `0005_first_party_apps_to_cloud`). That is the right production target and the
//! wrong development one: a developer editing `apps/medications-app` wants the
//! homescreen tile to open the vite dev server they are running, not the last
//! deploy of the public site.
//!
//! So a **debug build** additionally gets one self-hosted row per app, id
//! `<app>-dev`, bound to that app's fixed vite dev-server port. These rows cannot
//! be a migration: migrations are embedded, run unconditionally, and are tracked
//! by version, so a row created by one would also exist in every release
//! database. This runtime path is compiled out entirely in release: the whole
//! module is behind `#[cfg(debug_assertions)]` in `lib.rs`, as is its single call
//! site in `apps/wildflower-tauri/src-tauri/src/lib.rs`, so a release build
//! contains no code that could write these ids.
//!
//! The rows are self-hosted, so the host binds a loopback listener on the dev
//! port at startup. When vite already holds the port that bind fails — which is
//! the normal, intended case and is tolerated by design:
//! [`SelfHostedAppsService::start`](crate::SelfHostedAppsService::start) logs a
//! `ServerError::Bind` and carries on (only a poisoned lock propagates). Whoever
//! holds the port serves the app: vite when it is running, otherwise the host,
//! from the vendored build in `content_folder` (see the fallback caveat in
//! `slices/apps/self-hosted-apps/README.md`).
//!
//! Being self-hosted also restores app-relative OAuth redirects in dev: the
//! host's redirect resolver keys on `client_id` and requires the row to be
//! self-hosted, so `client_id == id == "<app>-dev"` is what lets the matching
//! dev gatekeeper client (seeded by `gatekeeper_rust::seed_dev_app_clients`)
//! register the app-relative `"/"` redirect. Each app's `src/config.ts` sends the
//! `-dev` client id when `import.meta.env.DEV` is set, which is exactly when it is
//! served by vite.

use anyhow::Context;
use diesel::sql_types::{Integer, Text};
use diesel::{RunQueryDsl, SqliteConnection};
use persistence_rust::DieselPool;

use crate::db::SqliteAppsStore;

/// One debug-only self-hosted row: an app id, its display fields, the vite
/// dev-server port it targets, and the vendored directory that serves as fallback
/// content when vite is not running.
struct DevApp {
    /// The row id — also its `client_id` and its dev gatekeeper client id (the
    /// redirect resolver requires all three to be equal).
    id: &'static str,
    /// Homescreen title, suffixed "(Dev)" so it can't be confused with the
    /// production cloud tile sitting next to it.
    name: &'static str,
    subtitle: &'static str,
    /// The app's vite dev-server port, read from the shared
    /// `slices/apps/dev-app-ports.json` — the same file the app's
    /// `vite.config.ts` reads for `server.port`, so the row and the dev server
    /// cannot drift.
    port: i32,
    /// Serving subdomain — unique across the registry, `-dev` suffixed so it can
    /// never collide with the production subdomains.
    subdomain: &'static str,
    /// The vendored build directory under `<app-data>/self-hosted-apps/`, used
    /// only when vite is not holding the port.
    content_folder: &'static str,
}

/// The SMART EHR-launch entry every first-party app ships, off its own origin —
/// the same template the pre-cloud seeded rows carried.
const DEV_LAUNCH_PATH: &str = "/launch.html?launch={launch}&iss={origin}/fhir-r4";

/// The shared dev-port file, embedded at compile time. The single source of
/// truth for these ports across the TS ⇄ Rust boundary: each app's
/// `vite.config.ts` reads the same file for `server.port` + `strictPort`, so vite
/// binds exactly the port the row below points at (and fails loudly rather than
/// silently drifting onto another one).
const DEV_APP_PORTS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../dev-app-ports.json"
));

/// The shape of [`DEV_APP_PORTS_JSON`] — one port per dev app id.
#[derive(serde::Deserialize)]
struct DevAppPorts {
    #[serde(rename = "medications-app-dev")]
    medications_app_dev: i32,
    #[serde(rename = "web-trace-app-dev")]
    web_trace_app_dev: i32,
}

/// The debug-only rows, with their ports read from the shared JSON.
///
/// # Panics
///
/// Panics if the embedded `dev-app-ports.json` is malformed or missing a key —
/// a compile-time-embedded, version-controlled file, so a failure here is a
/// broken build, not a runtime condition, and only ever reachable in a debug
/// build.
fn dev_apps() -> [DevApp; 2] {
    let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON)
        .expect("the embedded dev-app-ports.json must declare a port per dev app id");
    [
        DevApp {
            id: "medications-app-dev",
            name: "Medications (Dev)",
            subtitle: "Local vite dev server for apps/medications-app",
            port: ports.medications_app_dev,
            subdomain: "medication-dev",
            content_folder: "medication",
        },
        DevApp {
            id: "web-trace-app-dev",
            name: "Web Trace (Dev)",
            subtitle: "Local vite dev server for apps/web-trace",
            port: ports.web_trace_app_dev,
            subdomain: "web-trace-dev",
            content_folder: "web-trace",
        },
    ]
}

/// Seed (or reconcile) the debug-only `…-dev` app rows on `pool`.
///
/// Idempotent across restarts: a missing row is inserted at the tail of the
/// registry, an existing one keeps its user-chosen placement (`position` /
/// `on_homescreen` are never rewritten — those belong to `PUT /home-screen`)
/// while its display fields and serving topology are reconciled back to the
/// values above. A port or subdomain currently held by *another* app is tolerated
/// rather than fatal: the insert falls back to `MAX(port) + 1` (as the seed
/// migrations do), and the reconcile skips a value it cannot take.
///
/// Opens its own [`SqliteAppsStore`] so the apps migrations are applied first —
/// callers may run this before `setup_apps`, and must, if the host is to bind
/// listeners for the dev rows (the catalogue `setup_apps` hands back is read
/// once).
///
/// # Errors
///
/// Returns an error if the store cannot be opened/migrated, a connection cannot
/// be checked out, or a statement fails.
pub fn seed_dev_apps(pool: DieselPool) -> anyhow::Result<()> {
    // Applies the embedded apps migrations if `setup_apps` has not run yet.
    let _store = SqliteAppsStore::new(pool.clone()).context("failed to open apps store")?;
    let mut conn = pool
        .get()
        .context("failed to check out a connection to seed dev apps")?;
    for app in &dev_apps() {
        seed_one(&mut conn, app).with_context(|| format!("failed to seed dev app {}", app.id))?;
    }
    Ok(())
}

/// Insert-if-missing then reconcile a single [`DevApp`]. Split out so each row is
/// its own unit of work — a collision on one dev app never blocks the other.
fn seed_one(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    // The registration. `position` appends at the tail (`MAX + 1`) exactly like
    // the seed migrations, so it can't collide with the UNIQUE column; an
    // existing row is left in place, which is what keeps a developer's
    // drag-to-reorder from being undone on the next boot.
    diesel::sql_query(
        "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
         SELECT ?, 'self-hosted', (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations), \
                1, ?, ?, 0, ?, 0 \
          WHERE NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = ?)",
    )
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("insert dev registration")?;

    // Reconcile the display fields (and the kind/client_id invariants) without
    // touching placement.
    diesel::sql_query(
        "UPDATE app_registrations \
            SET kind = 'self-hosted', name = ?, subtitle = ?, local_only = 0, \
                client_id = ?, requires_tunnel = 0 \
          WHERE id = ?",
    )
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev registration")?;

    // The self-hosted payload. Both `port` and `subdomain` are UNIQUE, and an
    // uploaded app can already hold either, so the insert falls back the way the
    // seed migrations do: `MAX(port) + 1` (free by construction) and the app id
    // (free by construction — an upload's subdomain is its id, and the id is
    // taken by this very row). A fallback moves the dev app's origin, so the
    // vite server would no longer be the thing serving it; the reconcile below
    // pulls it back onto the pinned port as soon as the port frees up.
    diesel::sql_query(
        "INSERT INTO self_hosted_app_configurations \
             (id, port, content_folder, subdomain, seeded, launch_path) \
         SELECT ?, \
                CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE port = ?) \
                     THEN (SELECT MAX(port) + 1 FROM self_hosted_app_configurations) \
                     ELSE ? END, \
                ?, \
                CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE subdomain = ?) \
                     THEN ? \
                     ELSE ? END, \
                1, ? \
          WHERE NOT EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE id = ?) \
            AND EXISTS (SELECT 1 FROM app_registrations WHERE id = ?)",
    )
    .bind::<Text, _>(app.id)
    .bind::<Integer, _>(app.port)
    .bind::<Integer, _>(app.port)
    .bind::<Text, _>(app.content_folder)
    .bind::<Text, _>(app.subdomain)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.subdomain)
    .bind::<Text, _>(DEV_LAUNCH_PATH)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("insert dev self-hosted configuration")?;

    // Reconcile the payload back onto the pinned topology — but only the parts
    // that are actually free. The `id <> ?` guards make this a no-op when the row
    // already holds the pinned values (the ordinary restart), and skip the write
    // rather than fail when another app holds the port or subdomain.
    diesel::sql_query(
        "UPDATE self_hosted_app_configurations \
            SET content_folder = ?, launch_path = ?, seeded = 1 \
          WHERE id = ?",
    )
    .bind::<Text, _>(app.content_folder)
    .bind::<Text, _>(DEV_LAUNCH_PATH)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev content folder")?;

    diesel::sql_query(
        "UPDATE self_hosted_app_configurations \
            SET port = ? \
          WHERE id = ? \
            AND NOT EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE port = ? AND id <> ?)",
    )
    .bind::<Integer, _>(app.port)
    .bind::<Text, _>(app.id)
    .bind::<Integer, _>(app.port)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev port")?;

    diesel::sql_query(
        "UPDATE self_hosted_app_configurations \
            SET subdomain = ? \
          WHERE id = ? \
            AND NOT EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE subdomain = ? AND id <> ?)",
    )
    .bind::<Text, _>(app.subdomain)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.subdomain)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev subdomain")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AppConfiguration, AppsStore as _};

    /// The `(registration, configuration)` pair for a dev id, failing the test if
    /// the row is absent or of another kind.
    fn dev_self_hosted(
        store: &SqliteAppsStore,
        id: &str,
    ) -> (
        crate::domain::AppRegistration,
        crate::domain::SelfHostedAppConfiguration,
    ) {
        match store.find_app(id).unwrap() {
            Some((registration, AppConfiguration::SelfHosted(config))) => (registration, config),
            other => panic!("expected a self-hosted dev row for {id}, got {other:?}"),
        }
    }

    #[test]
    fn seeds_both_dev_rows_on_their_pinned_topology() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for app in &dev_apps() {
            let (registration, config) = dev_self_hosted(&store, app.id);
            assert_eq!(registration.name, app.name);
            // The redirect resolver requires `client_id == id`, and the app's dev
            // build sends exactly this id.
            assert_eq!(registration.client_id.as_deref(), Some(app.id));
            assert!(registration.on_homescreen);
            assert!(!registration.requires_tunnel);
            assert_eq!(i32::from(config.port), app.port);
            assert_eq!(config.subdomain, app.subdomain);
            assert_eq!(config.content_folder, app.content_folder);
            assert_eq!(config.launch_path.as_deref(), Some(DEV_LAUNCH_PATH));
        }
    }

    #[test]
    fn the_production_rows_stay_cloud_beside_the_dev_rows() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for id in ["medications-app", "web-trace-app"] {
            let (registration, config) = store.find_app(id).unwrap().expect("migrated cloud row");
            assert!(
                matches!(config, AppConfiguration::Cloud(_)),
                "{id} must stay cloud"
            );
            assert_eq!(registration.client_id.as_deref(), Some(id));
        }
    }

    #[test]
    fn is_idempotent_across_restarts() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let before = store.list_registrations().unwrap();

        // Three more "boots" must change nothing — not the row count, not the
        // ports, not the display order.
        for _ in 0..3 {
            seed_dev_apps(pool.clone()).unwrap();
        }
        let after = store.list_registrations().unwrap();
        assert_eq!(
            before.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            after.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        );
        for app in &dev_apps() {
            let (_, config) = dev_self_hosted(&store, app.id);
            assert_eq!(i32::from(config.port), app.port);
            assert_eq!(config.subdomain, app.subdomain);
        }
    }

    #[test]
    fn tolerates_an_uploaded_app_holding_the_pinned_port_and_subdomain() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();
        // An upload that grabbed the Medications dev port and subdomain first.
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
             VALUES ('squatter', 'self-hosted', 100, 1, 'Squatter', NULL, 0, NULL, 0)",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO self_hosted_app_configurations \
                 (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES ('squatter', ?, 'squatter', 'medication-dev', 0, NULL)",
        )
        .bind::<Integer, _>(dev_apps()[0].port)
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        // A collision must not abort the seed: the dev row lands on a fallback
        // origin rather than failing the boot.
        seed_dev_apps(pool.clone()).unwrap();
        let (_, config) = dev_self_hosted(&store, "medications-app-dev");
        assert_ne!(i32::from(config.port), dev_apps()[0].port);
        assert_eq!(config.subdomain, "medications-app-dev");
        // The other dev app is unaffected by its sibling's collision.
        let (_, other) = dev_self_hosted(&store, "web-trace-app-dev");
        assert_eq!(i32::from(other.port), dev_apps()[1].port);
        assert_eq!(other.subdomain, "web-trace-dev");
    }

    #[test]
    fn reclaims_the_pinned_port_once_the_squatter_is_gone() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
             VALUES ('squatter', 'self-hosted', 100, 1, 'Squatter', NULL, 0, NULL, 0)",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO self_hosted_app_configurations \
                 (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES ('squatter', ?, 'squatter', 'squatter', 0, NULL)",
        )
        .bind::<Integer, _>(dev_apps()[0].port)
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        seed_dev_apps(pool.clone()).unwrap();

        let mut conn = pool.get().unwrap();
        diesel::sql_query("DELETE FROM self_hosted_app_configurations WHERE id = 'squatter'")
            .execute(&mut conn)
            .unwrap();
        diesel::sql_query("DELETE FROM app_registrations WHERE id = 'squatter'")
            .execute(&mut conn)
            .unwrap();
        drop(conn);

        seed_dev_apps(pool).unwrap();
        let (_, config) = dev_self_hosted(&store, "medications-app-dev");
        assert_eq!(
            i32::from(config.port),
            dev_apps()[0].port,
            "the reconcile must pull the dev row back onto its pinned port",
        );
    }
}

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
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryableByName, RunQueryDsl, SqliteConnection};
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
/// **Only rows this seed owns are ever written.** A debug build can be opened
/// against a real user's database, so an id already held by something else — a
/// user's uploaded app, an app of another kind — is left strictly alone and
/// logged, never adopted (see [`DevRowOwnership`]).
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

/// What the database currently holds under a dev app's id — the ownership check
/// every write below is gated on.
///
/// A debug build can be pointed at a real user's database, so "the id is free, or
/// the row under it is one I wrote" has to be established before anything is
/// rewritten. The marker is the payload's `seeded` flag: this seed writes
/// `seeded = 1`, and the upload path writes `seeded = 0` unconditionally
/// (`db::self_hosted_apps::insert_self_hosted_app`), so a `seeded = 1`
/// self-hosted payload under a dev id can only have come from here.
#[derive(Debug, PartialEq, Eq)]
enum DevRowOwnership {
    /// No registration holds this id — free to seed.
    Absent,
    /// A registration holds it AND its payload is a `seeded = 1` self-hosted row:
    /// a row this seed wrote on an earlier boot, safe to reconcile.
    Ours,
    /// Something else holds the id — a user upload (`seeded = 0`), an app of
    /// another kind, or a registration whose payload is missing. Left strictly
    /// alone.
    Foreign,
}

/// Counts behind [`DevRowOwnership`], read in one statement so the two halves
/// can't be read either side of a concurrent write.
#[derive(QueryableByName)]
struct OwnershipCounts {
    #[diesel(sql_type = BigInt)]
    registrations: i64,
    #[diesel(sql_type = BigInt)]
    seeded_configurations: i64,
}

/// Classify what is stored under `id` (see [`DevRowOwnership`]).
fn ownership(conn: &mut SqliteConnection, id: &str) -> anyhow::Result<DevRowOwnership> {
    let counts: OwnershipCounts = diesel::sql_query(
        "SELECT (SELECT COUNT(*) FROM app_registrations WHERE id = ?) AS registrations, \
                (SELECT COUNT(*) FROM self_hosted_app_configurations WHERE id = ? AND seeded = 1) \
                    AS seeded_configurations",
    )
    .bind::<Text, _>(id)
    .bind::<Text, _>(id)
    .get_result(conn)
    .context("read dev app ownership")?;
    Ok(match (counts.registrations, counts.seeded_configurations) {
        (0, _) => DevRowOwnership::Absent,
        (_, 0) => DevRowOwnership::Foreign,
        _ => DevRowOwnership::Ours,
    })
}

/// Insert-if-missing then reconcile a single [`DevApp`] — but only when this seed
/// owns the id (see [`DevRowOwnership`]). Split out so each row is its own unit of
/// work: a collision on one dev app never blocks the other.
fn seed_one(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    match ownership(conn, app.id)? {
        // Someone else's row. Adopting it would silently rewrite a user's app —
        // its kind, its `client_id`, its name, and its serving origin — so skip
        // loudly instead. The developer either renames their app or lives without
        // that dev tile.
        DevRowOwnership::Foreign => {
            tracing::warn!(
                app = %app.id,
                "an app already exists under this dev id and was not written by the dev seed; \
                 leaving it untouched (no dev tile for this app)",
            );
            return Ok(());
        }
        DevRowOwnership::Absent => insert(conn, app)?,
        DevRowOwnership::Ours => {}
    }

    // Every statement below is additionally scoped to a `seeded = 1` payload, so
    // it stays a no-op against a foreign row even if it is ever reached without
    // the check above.
    reconcile(conn, app)
}

/// Write both halves of a fresh dev app: the registration, then its payload.
fn insert(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    // `position` appends at the tail (`MAX + 1`) exactly like the seed
    // migrations, so it can't collide with the UNIQUE column.
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

    // The self-hosted payload, marked `seeded = 1` — the ownership marker every
    // later write keys on. Both `port` and `subdomain` are UNIQUE, and an
    // uploaded app can already hold either, so the insert falls back the way the
    // seed migrations do: `MAX(port) + 1` (free by construction) and the app id
    // (free by construction — an upload's subdomain is its id, and the id is
    // taken by this very row). A fallback moves the dev app's origin, so the vite
    // server would no longer be the thing serving it; the reconcile pulls it back
    // onto the pinned port as soon as the port frees up.
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
    Ok(())
}

/// Pull an already-owned dev row back onto the values [`dev_apps`] declares.
///
/// Placement (`position` / `on_homescreen`) is deliberately never rewritten —
/// that belongs to `PUT /home-screen`, so a developer's reorder survives a
/// restart. Every statement carries the `seeded = 1` ownership predicate, and the
/// topology writes additionally skip (rather than fail on) a port or subdomain
/// another app holds; the reclaim happens on a later boot once it frees up.
fn reconcile(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    diesel::sql_query(
        "UPDATE app_registrations \
            SET kind = 'self-hosted', name = ?, subtitle = ?, local_only = 0, \
                client_id = ?, requires_tunnel = 0 \
          WHERE id = ? \
            AND EXISTS (SELECT 1 FROM self_hosted_app_configurations \
                         WHERE id = ? AND seeded = 1)",
    )
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev registration")?;

    diesel::sql_query(
        "UPDATE self_hosted_app_configurations \
            SET content_folder = ?, launch_path = ? \
          WHERE id = ? AND seeded = 1",
    )
    .bind::<Text, _>(app.content_folder)
    .bind::<Text, _>(DEV_LAUNCH_PATH)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev content folder")?;

    diesel::sql_query(
        "UPDATE self_hosted_app_configurations \
            SET port = ? \
          WHERE id = ? AND seeded = 1 \
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
          WHERE id = ? AND seeded = 1 \
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

    /// A debug build can be opened against a real user's database. An app the
    /// user uploaded under a dev id is NOT this seed's row (an upload always
    /// writes `seeded = 0`), so the seed must leave every one of its columns
    /// alone — kind, client_id, name, and its serving origin — rather than
    /// adopting and rewriting it.
    #[test]
    fn never_adopts_a_user_row_that_already_holds_a_dev_id() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();
        // An upload that slugged to exactly the dev id (`seeded = 0`).
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
             VALUES ('medications-app-dev', 'self-hosted', 100, 0, 'My Meds', 'Mine', 1, NULL, 0)",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO self_hosted_app_configurations \
                 (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES ('medications-app-dev', 9001, 'my-meds', 'medications-app-dev', 0, NULL)",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        seed_dev_apps(pool.clone()).unwrap();

        let (registration, config) = dev_self_hosted(&store, "medications-app-dev");
        assert_eq!(registration.name, "My Meds", "the user's name must survive");
        assert_eq!(registration.subtitle.as_deref(), Some("Mine"));
        assert!(registration.local_only, "the user's flags must survive");
        assert!(!registration.on_homescreen, "placement must survive");
        assert_eq!(
            registration.client_id, None,
            "the seed must not attach its client_id to a user's app",
        );
        assert_eq!(
            (i32::from(config.port), config.content_folder.as_str()),
            (9001, "my-meds"),
            "the user's serving origin and content must survive",
        );
        assert!(!config.seeded, "a user row stays user-owned");
        assert_eq!(config.launch_path, None);

        // A second boot must be just as inert, and the sibling dev app is
        // unaffected by its neighbour's collision.
        seed_dev_apps(pool).unwrap();
        let (again, _) = dev_self_hosted(&store, "medications-app-dev");
        assert_eq!(again.name, "My Meds");
        let (_, sibling) = dev_self_hosted(&store, "web-trace-app-dev");
        assert_eq!(i32::from(sibling.port), dev_apps()[1].port);
    }

    /// The same protection for a *cloud* app squatting a dev id: the payload the
    /// ownership check looks for isn't there, so the seed writes nothing at all —
    /// in particular it does not staple a self-hosted payload onto a cloud row.
    #[test]
    fn never_adopts_an_app_of_another_kind_under_a_dev_id() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
             VALUES ('web-trace-app-dev', 'cloud', 100, 1, 'Someone Elses', NULL, 0, NULL, 1)",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO cloud_app_configurations (id, url) \
             VALUES ('web-trace-app-dev', 'https://example.test/launch')",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        seed_dev_apps(pool).unwrap();

        let (registration, configuration) = store.find_app("web-trace-app-dev").unwrap().unwrap();
        assert_eq!(registration.name, "Someone Elses");
        assert!(
            matches!(configuration, AppConfiguration::Cloud(_)),
            "the seed must not turn a cloud app into a self-hosted one",
        );
        assert!(registration.requires_tunnel, "its flags must survive");
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

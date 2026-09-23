//! Debug-only seeding of the `…-dev` app rows that point at the first-party
//! apps' local vite dev servers.
//!
//! The first-party apps (Medications, Web Trace, Importer, the OHIF imaging
//! viewer, Server Docs) ship as **cloud** rows served from
//! <https://wildflowerhealth.io> (apps migration
//! `0005_first_party_apps_to_cloud`). That is the right production target and
//! the wrong development one: a developer editing `apps/medications-app` wants
//! the homescreen tile to open the vite dev server they are running, not the
//! last deploy of the public site.
//!
//! So a **debug build** additionally gets one cloud row per app, id
//! `<app>-dev`, whose launch URL names `localhost` and the app's fixed vite
//! dev-server port. There is no fallback content behind that port: the apps
//! build into their own `dist/` for the published site, nothing is vendored for
//! the host to serve, so the tile launches whatever is serving the port — and
//! nothing when the dev server is down. These rows cannot be a migration: migrations are embedded,
//! run unconditionally, and are tracked by version, so a row created by one
//! would also exist in every release database. This runtime path is compiled
//! out entirely in release: the whole module is behind
//! `#[cfg(debug_assertions)]` in `lib.rs`, as is its single call site in
//! `apps/wildflower-tauri/src-tauri/src/lib.rs`, so a release build contains
//! no code that could write these ids.
//!
//! Each app's dev gatekeeper client (`seed_dev_app_clients` in
//! gatekeeper-rust) registers an absolute `http://localhost:{port}` redirect
//! URI that the OAuth authorize flow matches directly — the cloud row is a
//! launch URL and nothing else.

use anyhow::Context;
use diesel::sql_types::{BigInt, Text};
use diesel::{QueryableByName, RunQueryDsl, SqliteConnection};
use persistence_rust::DieselPool;

use crate::db::SqliteAppsStore;

/// One debug-only row: an app id, its display fields, and the cloud launch URL
/// pointing at the local dev server.
struct DevApp {
    /// The row id — also its `client_id` and its dev gatekeeper client id.
    id: &'static str,
    /// Homescreen title, suffixed "(Dev)" so it can't be confused with the
    /// production cloud tile sitting next to it.
    name: &'static str,
    subtitle: &'static str,
    /// The app's vite dev-server port, read from the shared
    /// `slices/apps/dev-app-ports.json` — the same file the app's
    /// `vite.config.ts` reads for `server.port`, so the row and the dev server
    /// cannot drift. Read in tests to assert the URL embeds the right port.
    #[allow(dead_code)]
    port: i32,
    /// The cloud launch URL, built from the port.
    url: String,
}

/// The SMART EHR-launch URL template for a standard first-party dev app,
/// pointed at its loopback dev server.
fn dev_launch_url(port: i32) -> String {
    format!(
        "http://localhost:{port}/launch.html\
         ?launch={{launch}}&iss={{origin}}/fhir-r4"
    )
}

/// The OHIF viewer's dev launch URL — `/fhir-viewer` route with the **dev**
/// client id. See `docs/Apps/Explanation.md` for why this dev row is cloud.
fn ohif_viewer_dev_url(port: i32) -> String {
    format!(
        "http://localhost:{port}/fhir-viewer\
         ?launch={{launch}}&iss={{origin}}/fhir-r4&clientId=ohif-viewer-dev"
    )
}

/// The shared dev-port file, embedded at compile time. The single source of
/// truth for these ports across the TS ⇄ Rust boundary: each app's
/// `vite.config.ts` reads the same file for `server.port` + `strictPort`, so
/// vite binds exactly the port the row below points at (and fails loudly rather
/// than silently drifting onto another one).
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
    #[serde(rename = "web-server-docs-dev")]
    web_server_docs_dev: i32,
    #[serde(rename = "importer-app-dev")]
    importer_app_dev: i32,
    #[serde(rename = "ohif-viewer-dev")]
    ohif_viewer_dev: i32,
}

/// The debug-only rows, with their ports read from the shared JSON.
///
/// # Panics
///
/// Panics if the embedded `dev-app-ports.json` is malformed or missing a key —
/// a compile-time-embedded, version-controlled file, so a failure here is a
/// broken build, not a runtime condition, and only ever reachable in a debug
/// build.
fn dev_apps() -> [DevApp; 5] {
    let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON)
        .expect("the embedded dev-app-ports.json must declare a port per dev app id");
    [
        DevApp {
            id: "medications-app-dev",
            name: "Medications (Dev)",
            subtitle: "Local vite dev server for apps/medications-app",
            port: ports.medications_app_dev,
            url: dev_launch_url(ports.medications_app_dev),
        },
        DevApp {
            id: "web-trace-app-dev",
            name: "Web Trace (Dev)",
            subtitle: "Local vite dev server for apps/web-trace",
            port: ports.web_trace_app_dev,
            url: dev_launch_url(ports.web_trace_app_dev),
        },
        DevApp {
            id: "web-server-docs-dev",
            name: "Server Docs (Dev)",
            subtitle: "Local vite dev server for apps/wildflower-server-docs",
            port: ports.web_server_docs_dev,
            url: dev_launch_url(ports.web_server_docs_dev),
        },
        DevApp {
            id: "importer-app-dev",
            name: "Importer (Dev)",
            subtitle: "Local vite dev server for apps/importer-web",
            port: ports.importer_app_dev,
            url: dev_launch_url(ports.importer_app_dev),
        },
        DevApp {
            id: "ohif-viewer-dev",
            name: "Imaging (Dev)",
            subtitle: "Local preview server for apps/ohif-viewer",
            port: ports.ohif_viewer_dev,
            url: ohif_viewer_dev_url(ports.ohif_viewer_dev),
        },
    ]
}

/// Seed (or reconcile) the debug-only `…-dev` app rows on `pool`.
///
/// Idempotent across restarts: a missing row is inserted at the tail of the
/// registry, an existing one keeps its user-chosen placement (`position` /
/// `on_homescreen` are never rewritten — those belong to `PUT /home-screen`)
/// while its display fields and launch URL are reconciled back to the values
/// above.
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
/// A debug build can be pointed at a real user's database, so "the id is free,
/// or the row under it is one I wrote" has to be established before anything is
/// rewritten.
///
/// The marker is exact equality with the launch URL this seed would write. That
/// URL names a loopback dev port and the `-dev` OAuth client, so a user's own
/// cloud app matching it byte for byte is not a case worth distinguishing from
/// ours. A `seeded = 1` *self-hosted* payload also counts as ours: that is this
/// seed's own older shape, and recognising it is what lets an existing dev
/// database be converted in place rather than stranded as `Foreign` forever.
#[derive(Debug, PartialEq, Eq)]
enum DevRowOwnership {
    /// No registration holds this id — free to seed.
    Absent,
    /// A registration holds it AND its payload carries this seed's marker: a row
    /// this seed wrote on an earlier boot, safe to reconcile.
    Ours,
    /// Something else holds the id — a user upload, an app of another kind, or a
    /// registration whose payload is missing. Left strictly alone.
    Foreign,
}

/// Counts behind [`DevRowOwnership`], read in one statement so the two halves
/// can't be read either side of a concurrent write.
#[derive(QueryableByName)]
struct OwnershipCounts {
    #[diesel(sql_type = BigInt)]
    registrations: i64,
    /// Payload rows under this id that carry this seed's ownership marker.
    #[diesel(sql_type = BigInt)]
    owned_configurations: i64,
}

/// Classify what is stored under `app`'s id (see [`DevRowOwnership`]).
fn ownership(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<DevRowOwnership> {
    // The cloud payload this seed writes, or the self-hosted payload an older
    // build of this seed wrote under the same id (converted by `reconcile`).
    let counts: OwnershipCounts = diesel::sql_query(
        "SELECT (SELECT COUNT(*) FROM app_registrations WHERE id = ?) AS registrations, \
                ((SELECT COUNT(*) FROM cloud_app_configurations WHERE id = ? AND url = ?) \
                 + (SELECT COUNT(*) FROM self_hosted_app_configurations \
                     WHERE id = ? AND seeded = 1)) AS owned_configurations",
    )
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.url.as_str())
    .bind::<Text, _>(app.id)
    .get_result(conn)
    .context("read dev app ownership")?;
    Ok(match (counts.registrations, counts.owned_configurations) {
        (0, _) => DevRowOwnership::Absent,
        (_, 0) => DevRowOwnership::Foreign,
        _ => DevRowOwnership::Ours,
    })
}

/// Insert-if-missing then reconcile a single [`DevApp`] — but only when this
/// seed owns the id (see [`DevRowOwnership`]). Split out so each row is its own
/// unit of work: a collision on one dev app never blocks the others.
fn seed_one(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    match ownership(conn, app)? {
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
    reconcile(conn, app)
}

/// Write the registration for a fresh dev app. The cloud payload is written by
/// [`reconcile`], which runs immediately after — the same statement serves a
/// fresh insert and the in-place conversion of a legacy self-hosted dev row.
fn insert(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    diesel::sql_query(
        "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
         SELECT ?, 'cloud', (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations), \
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
    Ok(())
}

/// Pull an already-owned dev row onto its launch URL, converting a legacy
/// self-hosted payload this seed wrote under an older shape if one is still
/// there.
///
/// Placement (`position` / `on_homescreen`) is deliberately never rewritten —
/// that belongs to `PUT /home-screen`, so a developer's reorder survives a
/// restart.
fn reconcile(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    // Drop any self-hosted payload this seed wrote under an older shape.
    diesel::sql_query("DELETE FROM self_hosted_app_configurations WHERE id = ? AND seeded = 1")
        .bind::<Text, _>(app.id)
        .execute(conn)
        .context("drop a superseded self-hosted payload")?;

    // `INSERT OR REPLACE` so a fresh insert and a reconcile are one statement.
    diesel::sql_query(
        "INSERT OR REPLACE INTO cloud_app_configurations (id, url) \
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = ?)",
    )
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.url.as_str())
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev cloud configuration")?;

    reconcile_registration(conn, app)
}

/// Reconcile the shared registration columns. Scoped to a cloud payload
/// carrying this seed's URL, so it stays inert against a foreign row.
fn reconcile_registration(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    diesel::sql_query(
        "UPDATE app_registrations \
            SET kind = 'cloud', name = ?, subtitle = ?, local_only = 0, \
                client_id = ?, requires_tunnel = 0 \
          WHERE id = ? \
            AND EXISTS (SELECT 1 FROM cloud_app_configurations WHERE id = ? AND url = ?)",
    )
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.url.as_str())
    .execute(conn)
    .context("reconcile dev registration")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AppConfiguration, AppsStore as _};
    use diesel::sql_types::Integer;

    /// The `(registration, configuration)` pair for a cloud dev id, failing the
    /// test if the row is absent or of another kind.
    fn dev_cloud(
        store: &SqliteAppsStore,
        id: &str,
    ) -> (
        crate::domain::AppRegistration,
        crate::domain::CloudAppConfiguration,
    ) {
        match store.find_app(id).unwrap() {
            Some((registration, AppConfiguration::Cloud(config))) => (registration, config),
            other => panic!("expected a cloud dev row for {id}, got {other:?}"),
        }
    }

    #[test]
    fn seeds_all_dev_rows_as_cloud_on_their_pinned_topology() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for app in &dev_apps() {
            let (registration, config) = dev_cloud(&store, app.id);
            assert_eq!(config.url.to_string(), app.url);
            assert_eq!(registration.name, app.name);
            assert_eq!(registration.client_id.as_deref(), Some(app.id));
            assert!(registration.on_homescreen);
            assert!(!registration.requires_tunnel);
        }
    }

    #[test]
    fn the_ohif_dev_row_uses_its_own_launch_url_shape() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        let port = dev_apps()
            .iter()
            .find(|app| app.id == "ohif-viewer-dev")
            .expect("the OHIF dev row")
            .port;
        let (_, config) = dev_cloud(&store, "ohif-viewer-dev");
        assert_eq!(
            config.url.to_string(),
            format!(
                "http://localhost:{port}/fhir-viewer\
                 ?launch={{launch}}&iss={{origin}}/fhir-r4&clientId=ohif-viewer-dev"
            ),
        );
    }

    /// A dev database seeded by an older build holds dev apps as `seeded = 1`
    /// SELF-HOSTED rows. Those are still this seed's own rows, so the next boot
    /// must convert them in place to cloud.
    #[test]
    fn converts_a_previously_self_hosted_dev_row_to_cloud() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();

        let app = &dev_apps()[0]; // medications-app-dev
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
             VALUES (?, 'self-hosted', 100, 1, ?, NULL, 0, ?, 0)",
        )
        .bind::<Text, _>(app.id)
        .bind::<Text, _>(app.name)
        .bind::<Text, _>(app.id)
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO self_hosted_app_configurations \
                 (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES (?, ?, 'medication', 'medication-dev', 1, \
                     '/launch.html?launch={launch}&iss={origin}/fhir-r4')",
        )
        .bind::<Text, _>(app.id)
        .bind::<Integer, _>(app.port)
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        seed_dev_apps(pool.clone()).unwrap();

        let (registration, config) = dev_cloud(&store, app.id);
        assert_eq!(config.url.to_string(), app.url);
        assert_eq!(registration.position, 100, "placement must survive");
        assert_eq!(registration.client_id.as_deref(), Some(app.id));
        // The superseded self-hosted payload must be gone.
        let mut conn = pool.get().unwrap();
        let counts: OwnershipCounts = diesel::sql_query(
            "SELECT 0 AS registrations, \
                    (SELECT COUNT(*) FROM self_hosted_app_configurations \
                      WHERE id = ?) AS owned_configurations",
        )
        .bind::<Text, _>(app.id)
        .get_result(&mut conn)
        .unwrap();
        assert_eq!(counts.owned_configurations, 0);
    }

    #[test]
    fn the_production_rows_stay_cloud_beside_the_dev_rows() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for id in [
            "medications-app",
            "web-trace-app",
            "importer-app",
            "ohif-viewer",
        ] {
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

        for _ in 0..3 {
            seed_dev_apps(pool.clone()).unwrap();
        }
        let after = store.list_registrations().unwrap();
        assert_eq!(
            before.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            after.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        );
        for app in &dev_apps() {
            let (_, config) = dev_cloud(&store, app.id);
            assert_eq!(config.url.to_string(), app.url);
        }
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

        let (registration, config) = store.find_app("medications-app-dev").unwrap().unwrap();
        assert!(
            matches!(config, AppConfiguration::SelfHosted(_)),
            "the seed must not convert a user's self-hosted app to cloud",
        );
        assert_eq!(registration.name, "My Meds", "the user's name must survive");
        assert_eq!(registration.subtitle.as_deref(), Some("Mine"));
        assert!(registration.local_only, "the user's flags must survive");
        assert!(!registration.on_homescreen, "placement must survive");
        assert_eq!(
            registration.client_id, None,
            "the seed must not attach its client_id to a user's app",
        );

        // A second boot must be just as inert, and the sibling dev app is
        // unaffected by its neighbour's collision.
        seed_dev_apps(pool).unwrap();
        let (again, _) = store.find_app("medications-app-dev").unwrap().unwrap();
        assert_eq!(again.name, "My Meds");
        let (_, sibling) = dev_cloud(&store, "web-trace-app-dev");
        assert_eq!(sibling.url.to_string(), dev_apps()[1].url);
    }

    /// The same protection for a *cloud* app squatting a dev id: the URL the
    /// ownership check looks for isn't there, so the seed writes nothing at all.
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
            "the seed must not overwrite a foreign cloud app",
        );
        assert!(registration.requires_tunnel, "its flags must survive");
    }
}

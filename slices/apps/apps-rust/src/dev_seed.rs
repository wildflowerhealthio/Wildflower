//! Debug-only seeding of the `…-dev` app rows that point at the first-party
//! apps' local vite dev servers.
//!
//! The first-party apps (Medications, Web Trace, Importer, the OHIF imaging
//! viewer, Server Docs, the Synthesized Health Viewer, the Synthetic Data
//! Loader, Lifting) ship as rows served from
//! <https://wildflowerhealth.io> (apps migration
//! `0005_first_party_apps_to_cloud`). That is the right production target and
//! the wrong development one: a developer editing `apps/medications-app` wants
//! the homescreen tile to open the vite dev server they are running, not the
//! last deploy of the public site.
//!
//! So a **debug build** additionally gets one row per app, id
//! `<app>-dev`, whose launch URL names `localhost` and the app's fixed vite
//! dev-server port. There is no fallback content behind that port: the apps
//! build into their own `dist/` for the published site, nothing is vendored for
//! the host to serve, so the tile launches whatever is serving the port — and
//! nothing when the dev server is down. These rows cannot be a migration: migrations are embedded,
//! run unconditionally, and are tracked by version, so a row created by one
//! would also exist in every release database. This runtime path is compiled
//! out entirely in release: the whole module is behind
//! `#[cfg(debug_assertions)]` in `lib.rs`, as is its single call site in
//! `slices/wildflower-server/wildflower-server-rust/src/live_bindings/wildflower_server.rs`,
//! so a release build contains no code that could write these ids.
//!
//! Each app's dev gatekeeper client (`seed_dev_app_clients` in
//! gatekeeper-rust) registers an absolute `http://localhost:{port}` redirect
//! URI that the OAuth authorize flow matches directly — the row is a launch URL
//! and nothing else.

use anyhow::Context;
use diesel::sql_types::Text;
use diesel::{OptionalExtension, QueryableByName, RunQueryDsl, SqliteConnection};
use persistence_rust::DieselPool;

use crate::db::SqliteAppsStore;

/// The Lifting dev tile's OAuth client: a random id (`openssl rand -hex 16`),
/// not the tile id. gatekeeper-rust's `seed_dev_app_clients` registers it, and
/// `apps/lifting/lifting-web/src/config.ts` launches as it under the dev server.
const LIFTING_DEV_CLIENT_ID: &str = "8467e680a05f1e92e22864e923144e5a";

/// One debug-only row: an app id, its display fields, its OAuth client, and the
/// launch URL pointing at the local dev server.
struct DevApp {
    /// The row id.
    id: &'static str,
    /// The row's `client_id`: its dev gatekeeper client, which
    /// `seed_dev_app_clients` registers under the same id.
    client_id: &'static str,
    /// Homescreen title, suffixed "(Dev)" so it can't be confused with the
    /// production tile sitting next to it.
    name: &'static str,
    subtitle: &'static str,
    /// The launch URL, built from the app's vite dev-server port in the shared
    /// `slices/apps/dev-app-ports.json` — the same file the app's
    /// `vite.config.ts` reads for `server.port`, so the row and the dev server
    /// cannot drift.
    url: String,
}

/// The SMART EHR-launch URL template for a standard first-party dev app,
/// pointed at its loopback dev server's root.
fn dev_launch_url(port: i32) -> String {
    format!("http://localhost:{port}/?launch={{launch}}&iss={{origin}}/fhir-r4")
}

/// The OHIF viewer's dev launch URL — `/fhir-viewer` route with the **dev**
/// client id.
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
    #[serde(rename = "health-viewer-app-dev")]
    health_viewer_app_dev: i32,
    #[serde(rename = "synthetic-data-app-dev")]
    synthetic_data_app_dev: i32,
    #[serde(rename = "lifting-dev")]
    lifting_dev: i32,
}

/// The debug-only rows, with their ports read from the shared JSON.
///
/// # Panics
///
/// Panics if the embedded `dev-app-ports.json` is malformed or missing a key —
/// a compile-time-embedded, version-controlled file, so a failure here is a
/// broken build, not a runtime condition, and only ever reachable in a debug
/// build.
fn dev_apps() -> [DevApp; 8] {
    let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON)
        .expect("the embedded dev-app-ports.json must declare a port per dev app id");
    [
        DevApp {
            id: "medications-app-dev",
            client_id: "medications-app-dev",
            name: "Medications (Dev)",
            subtitle: "Local vite dev server for apps/medications-app",
            url: dev_launch_url(ports.medications_app_dev),
        },
        DevApp {
            id: "web-trace-app-dev",
            client_id: "web-trace-app-dev",
            name: "Web Trace (Dev)",
            subtitle: "Local vite dev server for apps/web-trace",
            url: dev_launch_url(ports.web_trace_app_dev),
        },
        DevApp {
            id: "web-server-docs-dev",
            client_id: "web-server-docs-dev",
            name: "Server Docs (Dev)",
            subtitle: "Local vite dev server for apps/wildflower-server-docs",
            url: dev_launch_url(ports.web_server_docs_dev),
        },
        DevApp {
            id: "importer-app-dev",
            client_id: "importer-app-dev",
            name: "Importer (Dev)",
            subtitle: "Local vite dev server for apps/importer-web",
            url: dev_launch_url(ports.importer_app_dev),
        },
        DevApp {
            id: "ohif-viewer-dev",
            client_id: "ohif-viewer-dev",
            name: "Imaging (Dev)",
            subtitle: "Local preview server for apps/ohif-viewer",
            url: ohif_viewer_dev_url(ports.ohif_viewer_dev),
        },
        DevApp {
            id: "health-viewer-app-dev",
            client_id: "health-viewer-app-dev",
            name: "Health Viewer (Dev)",
            subtitle: "Local vite dev server for apps/health-viewer",
            url: dev_launch_url(ports.health_viewer_app_dev),
        },
        DevApp {
            id: "synthetic-data-app-dev",
            client_id: "synthetic-data-app-dev",
            name: "Synthetic Data (Dev)",
            subtitle: "Local vite dev server for apps/synthetic-data-app",
            url: dev_launch_url(ports.synthetic_data_app_dev),
        },
        DevApp {
            id: "lifting-dev",
            client_id: LIFTING_DEV_CLIENT_ID,
            name: "Lifting (Dev)",
            subtitle: "Local vite dev server for apps/lifting/lifting-web",
            url: dev_launch_url(ports.lifting_dev),
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
/// user's own app — is left strictly alone and logged, never adopted (see [`DevRowOwnership`]).
///
/// Opens its own [`SqliteAppsStore`] so the apps migrations are applied first —
/// callers may run this before `setup_apps`.
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
/// app matching it byte for byte is not a case worth distinguishing from ours.
#[derive(Debug, PartialEq, Eq)]
enum DevRowOwnership {
    /// No registration holds this id — free to seed.
    Absent,
    /// A registration holds it AND carries this seed's launch URL: a row this
    /// seed wrote on an earlier boot, safe to reconcile.
    Ours,
    /// Something else holds the id — a user's own app. Left strictly alone.
    Foreign,
}

/// The stored launch URL under a dev app's id — the ownership marker.
#[derive(QueryableByName)]
struct StoredUrl {
    #[diesel(sql_type = Text)]
    url: String,
}

/// Classify what is stored under `app`'s id (see [`DevRowOwnership`]).
fn ownership(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<DevRowOwnership> {
    let stored: Option<StoredUrl> =
        diesel::sql_query("SELECT url FROM app_registrations WHERE id = ?")
            .bind::<Text, _>(app.id)
            .get_result(conn)
            .optional()
            .context("read dev app ownership")?;
    Ok(match stored {
        None => DevRowOwnership::Absent,
        Some(stored) if stored.url == app.url => DevRowOwnership::Ours,
        Some(_) => DevRowOwnership::Foreign,
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
            Ok(())
        }
        DevRowOwnership::Absent => insert(conn, app),
        DevRowOwnership::Ours => reconcile(conn, app),
    }
}

/// Write a fresh dev app at the tail of the registry.
fn insert(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    diesel::sql_query(
        "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, subtitle, url, client_id, requires_tunnel) \
         SELECT ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations), \
                1, ?, ?, ?, ?, 0 \
          WHERE NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = ?)",
    )
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.url.as_str())
    .bind::<Text, _>(app.client_id)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("insert dev registration")?;
    Ok(())
}

/// Pull an already-owned dev row back onto its display fields.
///
/// Placement (`position` / `on_homescreen`) is deliberately never rewritten —
/// that belongs to `PUT /home-screen`, so a developer's reorder survives a
/// restart. Scoped to a row carrying this seed's URL, so it stays inert against a
/// foreign row.
fn reconcile(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    diesel::sql_query(
        "UPDATE app_registrations \
            SET name = ?, subtitle = ?, client_id = ?, requires_tunnel = 0 \
          WHERE id = ? AND url = ?",
    )
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.client_id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.url.as_str())
    .execute(conn)
    .context("reconcile dev registration")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AppRegistration, AppsStore as _};

    /// The registration under a dev id, failing the test if the row is absent.
    fn dev_row(store: &SqliteAppsStore, id: &str) -> AppRegistration {
        store
            .find_app(id)
            .unwrap()
            .unwrap_or_else(|| panic!("expected a dev row for {id}"))
    }

    #[test]
    fn seeds_all_dev_rows_on_their_pinned_topology() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for app in &dev_apps() {
            let registration = dev_row(&store, app.id);
            assert_eq!(registration.url.to_string(), app.url);
            assert_eq!(registration.name, app.name);
            assert_eq!(registration.client_id.as_deref(), Some(app.client_id));
            assert!(registration.on_homescreen);
            assert!(!registration.requires_tunnel);
        }
    }

    #[test]
    fn the_ohif_dev_row_uses_its_own_launch_url_shape() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).unwrap();
        let port = ports.ohif_viewer_dev;
        let registration = dev_row(&store, "ohif-viewer-dev");
        assert_eq!(
            registration.url.to_string(),
            format!(
                "http://localhost:{port}/fhir-viewer\
                 ?launch={{launch}}&iss={{origin}}/fhir-r4&clientId=ohif-viewer-dev"
            ),
        );
    }

    #[test]
    fn the_health_viewer_dev_row_launches_its_dev_server() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).unwrap();
        let port = ports.health_viewer_app_dev;
        let registration = dev_row(&store, "health-viewer-app-dev");
        assert_eq!(registration.name, "Health Viewer (Dev)");
        assert_eq!(
            registration.subtitle.as_deref(),
            Some("Local vite dev server for apps/health-viewer"),
        );
        assert_eq!(
            registration.url.to_string(),
            format!("http://localhost:{port}/?launch={{launch}}&iss={{origin}}/fhir-r4"),
        );
    }

    #[test]
    fn the_synthetic_data_dev_row_launches_its_dev_server() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).unwrap();
        let port = ports.synthetic_data_app_dev;
        let registration = dev_row(&store, "synthetic-data-app-dev");
        assert_eq!(registration.name, "Synthetic Data (Dev)");
        assert_eq!(
            registration.subtitle.as_deref(),
            Some("Local vite dev server for apps/synthetic-data-app"),
        );
        assert_eq!(
            registration.url.to_string(),
            format!("http://localhost:{port}/?launch={{launch}}&iss={{origin}}/fhir-r4"),
        );
    }

    #[test]
    fn the_lifting_dev_row_launches_its_dev_server() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).unwrap();
        let port = ports.lifting_dev;
        let registration = dev_row(&store, "lifting-dev");
        assert_eq!(registration.name, "Lifting (Dev)");
        assert_eq!(
            registration.subtitle.as_deref(),
            Some("Local vite dev server for apps/lifting/lifting-web"),
        );
        assert_eq!(
            registration.client_id.as_deref(),
            Some(LIFTING_DEV_CLIENT_ID)
        );
        assert_eq!(
            registration.url.to_string(),
            format!("http://localhost:{port}/?launch={{launch}}&iss={{origin}}/fhir-r4"),
        );
    }

    #[test]
    fn the_production_rows_stay_beside_the_dev_rows() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for (id, client_id) in [
            ("medications-app", "medications-app"),
            ("web-trace-app", "web-trace-app"),
            ("importer-app", "importer-app"),
            ("ohif-viewer", "ohif-viewer"),
            ("lifting", "bdf9fc5cb5a28c6683b49896b0ef8a75"),
            ("health-viewer-app", "health-viewer-app"),
        ] {
            let registration = store.find_app(id).unwrap().expect("migrated row");
            assert_eq!(registration.client_id.as_deref(), Some(client_id));
            assert!(
                registration
                    .url
                    .to_string()
                    .starts_with("https://wildflowerhealth.io/"),
                "{id} keeps its published launch URL",
            );
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
            assert_eq!(dev_row(&store, app.id).url.to_string(), app.url);
        }
    }

    /// A debug build can be opened against a real user's database. An app the
    /// user created under a dev id is NOT this seed's row (its launch URL isn't the
    /// one this seed writes), so the seed must leave every one of its columns
    /// alone — name, flags, placement, client_id, and its launch URL — rather than
    /// adopting and rewriting it.
    #[test]
    fn never_adopts_a_user_row_that_already_holds_a_dev_id() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, position, on_homescreen, name, subtitle, url, client_id, requires_tunnel) \
             VALUES ('medications-app-dev', 100, 0, 'My Meds', 'Mine', \
                     'https://example.test/my-meds', NULL, 1)",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        seed_dev_apps(pool.clone()).unwrap();

        let registration = dev_row(&store, "medications-app-dev");
        assert_eq!(
            registration.url.to_string(),
            "https://example.test/my-meds",
            "the seed must not overwrite the user's launch URL",
        );
        assert_eq!(registration.name, "My Meds", "the user's name must survive");
        assert_eq!(registration.subtitle.as_deref(), Some("Mine"));
        assert!(
            registration.requires_tunnel,
            "the user's flags must survive"
        );
        assert!(!registration.on_homescreen, "placement must survive");
        assert_eq!(
            registration.client_id, None,
            "the seed must not attach its client_id to a user's app",
        );

        // A second boot must be just as inert, and the sibling dev app is
        // unaffected by its neighbour's collision.
        seed_dev_apps(pool).unwrap();
        assert_eq!(dev_row(&store, "medications-app-dev").name, "My Meds");
        let sibling = dev_row(&store, "web-trace-app-dev");
        assert_eq!(sibling.url.to_string(), dev_apps()[1].url);
    }
}

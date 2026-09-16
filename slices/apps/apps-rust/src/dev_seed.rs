//! Debug-only seeding of the `…-dev` app rows that point at the first-party
//! apps' local vite dev servers.
//!
//! The first-party apps (Medications, Web Trace, Importer, the OHIF imaging
//! viewer) ship as **cloud** rows
//! served from <https://wildflowerhealth.io> (apps migration
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
//! Most of those rows are **self-hosted**, so the host binds a loopback listener
//! on the dev port at startup. When vite already holds the port that bind fails —
//! which is the normal, intended case and is tolerated by design:
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
//!
//! **`ohif-viewer-dev` is the exception: it is a CLOUD row** pointed at its own
//! loopback dev origin (see [`DevServing::Cloud`]). Nothing is vendored under
//! `self-hosted-apps/ohif-viewer`, so the host had no fallback content to serve
//! and its loopback listener only ever competed with the preview server for the
//! port; a cloud row is a launch URL and nothing else, which leaves the preview
//! server the sole origin and so keeps the viewer's cross-origin behaviour in dev
//! identical to production. Its dev gatekeeper client compensates for the lost
//! app-relative redirect with an absolute loopback one on the same route (see
//! `gatekeeper_rust::seed_dev_app_clients`).

use anyhow::Context;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryableByName, RunQueryDsl, SqliteConnection};
use persistence_rust::DieselPool;

use crate::db::SqliteAppsStore;

/// One debug-only row: an app id, its display fields, the vite dev-server port it
/// targets, and how that dev server is reached ([`DevServing`]).
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
    /// Which kind of row this dev app is, and that kind's payload.
    serving: DevServing,
}

impl DevApp {
    /// The `app_registrations.kind` discriminator this row is written with.
    fn kind(&self) -> &'static str {
        match self.serving {
            DevServing::SelfHosted(_) => "self-hosted",
            DevServing::Cloud(_) => "cloud",
        }
    }

    /// The launch URL a cloud dev app is keyed on, or `None` for a self-hosted
    /// one. Lets the shared registration reconcile bind one ownership predicate
    /// covering both kinds; a self-hosted app binds an empty string, which the
    /// `NOT NULL` `url` column can never equal.
    fn cloud_url(&self) -> Option<&str> {
        match &self.serving {
            DevServing::SelfHosted(_) => None,
            DevServing::Cloud(cloud) => Some(cloud.url.as_str()),
        }
    }
}

/// How a dev app's tile reaches its dev server — the row `kind` this seed writes,
/// and that kind's configuration payload.
enum DevServing {
    /// The default: a self-hosted row on the pinned loopback port, with vendored
    /// fallback content for when vite is not holding the port (see the module
    /// docs).
    SelfHosted(SelfHostedServing),
    /// A cloud row whose launch URL is the dev server's own loopback origin. For
    /// a dev app the host must NOT bind a listener for: with nothing vendored to
    /// fall back to, a host listener could only ever contend for the port.
    Cloud(CloudServing),
}

/// The [`DevServing::SelfHosted`] payload.
struct SelfHostedServing {
    /// Serving subdomain — unique across the registry, `-dev` suffixed so it can
    /// never collide with the production subdomains.
    subdomain: &'static str,
    /// The vendored build directory under `<app-data>/self-hosted-apps/`, used
    /// only when vite is not holding the port.
    content_folder: &'static str,
    /// The SMART EHR-launch entry, relative to the row's own origin — see
    /// [`DEV_LAUNCH_PATH`].
    launch_path: &'static str,
}

/// The [`DevServing::Cloud`] payload: the absolute launch template that goes into
/// `cloud_app_configurations.url`. Built from the app's [`DevApp::port`] rather
/// than written as a literal, so it tracks the shared dev-port file, and it
/// doubles as this seed's ownership marker for the row — a cloud configuration
/// has no `seeded` column (see [`DevRowOwnership`]).
struct CloudServing {
    url: String,
}

/// The SMART EHR-launch entry every first-party app ships, off its own origin —
/// the same template the pre-cloud seeded rows carried.
const DEV_LAUNCH_PATH: &str = "/launch.html?launch={launch}&iss={origin}/fhir-r4";

/// The launch route + query the OHIF viewer's dev cloud row targets, formatted
/// with its loopback dev origin. Mirrors the production cloud row's template
/// (apps migration `0007_seed_ohif_viewer_app`) route for route: OHIF is a single
/// page app whose FHIR data source reads `launch`, `iss` and `clientId` off the
/// URL of whichever route it is opened on, and the EHR launch lands on the FHIR
/// Viewer mode directly.
///
/// `clientId` is the **dev** client (`ohif-viewer-dev`), not the production one:
/// a cloud row's redirect can only match an absolute registered URI, and it is
/// the dev client that registers this loopback route (`seed_dev_app_clients`).
/// `{origin}` stays a template — the host substitutes its own FHIR base.
fn ohif_viewer_dev_url(port: i32) -> String {
    format!(
        "http://localhost:{port}/fhir-viewer\
         ?launch={{launch}}&iss={{origin}}/fhir-r4&clientId=ohif-viewer-dev"
    )
}

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
            serving: DevServing::SelfHosted(SelfHostedServing {
                subdomain: "medication-dev",
                content_folder: "medication",
                launch_path: DEV_LAUNCH_PATH,
            }),
        },
        DevApp {
            id: "web-trace-app-dev",
            name: "Web Trace (Dev)",
            subtitle: "Local vite dev server for apps/web-trace",
            port: ports.web_trace_app_dev,
            serving: DevServing::SelfHosted(SelfHostedServing {
                subdomain: "web-trace-dev",
                content_folder: "web-trace",
                launch_path: DEV_LAUNCH_PATH,
            }),
        },
        DevApp {
            id: "web-server-docs-dev",
            name: "Server Docs (Dev)",
            subtitle: "Local vite dev server for apps/wildflower-server-docs",
            port: ports.web_server_docs_dev,
            serving: DevServing::SelfHosted(SelfHostedServing {
                subdomain: "web-server-docs",
                content_folder: "web-server-docs",
                launch_path: DEV_LAUNCH_PATH,
            }),
        },
        DevApp {
            id: "importer-app-dev",
            name: "Importer (Dev)",
            subtitle: "Local vite dev server for apps/importer-web",
            port: ports.importer_app_dev,
            serving: DevServing::SelfHosted(SelfHostedServing {
                subdomain: "importer-dev",
                content_folder: "importer",
                launch_path: DEV_LAUNCH_PATH,
            }),
        },
        DevApp {
            id: "ohif-viewer-dev",
            name: "Imaging (Dev)",
            // Not a vite dev server: `apps/ohif-viewer` is a downloaded prebuilt
            // OHIF build, and `vp run -F ohif-viewer dev` (`vp preview`) serves it
            // on this port. CLOUD rather than self-hosted, unlike every row above:
            // nothing is vendored under `self-hosted-apps/ohif-viewer`, so a host
            // listener on this port would have no content to fall back to and
            // could only contend with the preview server for the origin. See the
            // module docs.
            subtitle: "Local preview server for apps/ohif-viewer",
            port: ports.ohif_viewer_dev,
            serving: DevServing::Cloud(CloudServing {
                url: ohif_viewer_dev_url(ports.ohif_viewer_dev),
            }),
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
/// rewritten.
///
/// For a **self-hosted** dev app the marker is the payload's `seeded` flag: this
/// seed writes `seeded = 1`, and the upload path writes `seeded = 0`
/// unconditionally (`db::self_hosted_apps::insert_self_hosted_app`), so a
/// `seeded = 1` self-hosted payload under a dev id can only have come from here.
///
/// A **cloud** configuration has no `seeded` column — cloud apps are freely
/// editable and deletable, so the schema never needed one — and the marker is
/// instead exact equality with the launch URL this seed would write
/// ([`CloudServing::url`]). That URL names a loopback dev port and the `-dev`
/// OAuth client, so a user's own cloud app matching it byte for byte is not a
/// case worth distinguishing from ours. A `seeded = 1` *self-hosted* payload also
/// counts as ours for a cloud dev app: that is this seed's own older shape, and
/// recognising it is what lets an existing dev database be converted in place
/// rather than stranded as `Foreign` forever.
#[derive(Debug, PartialEq, Eq)]
enum DevRowOwnership {
    /// No registration holds this id — free to seed.
    Absent,
    /// A registration holds it AND its payload carries this seed's marker: a row
    /// this seed wrote on an earlier boot, safe to reconcile.
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
    /// Payload rows under this id that carry this seed's ownership marker — what
    /// counts as a marker depends on the app's [`DevServing`].
    #[diesel(sql_type = BigInt)]
    owned_configurations: i64,
}

/// Classify what is stored under `app`'s id (see [`DevRowOwnership`]).
fn ownership(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<DevRowOwnership> {
    let counts: OwnershipCounts = match &app.serving {
        DevServing::SelfHosted(_) => diesel::sql_query(
            "SELECT (SELECT COUNT(*) FROM app_registrations WHERE id = ?) AS registrations, \
                    (SELECT COUNT(*) FROM self_hosted_app_configurations \
                      WHERE id = ? AND seeded = 1) AS owned_configurations",
        )
        .bind::<Text, _>(app.id)
        .bind::<Text, _>(app.id)
        .get_result(conn),
        // Either the cloud payload this seed writes, or the self-hosted payload
        // an older build of this seed wrote under the same id (converted by
        // `reconcile`).
        DevServing::Cloud(cloud) => diesel::sql_query(
            "SELECT (SELECT COUNT(*) FROM app_registrations WHERE id = ?) AS registrations, \
                    ((SELECT COUNT(*) FROM cloud_app_configurations WHERE id = ? AND url = ?) \
                     + (SELECT COUNT(*) FROM self_hosted_app_configurations \
                         WHERE id = ? AND seeded = 1)) AS owned_configurations",
        )
        .bind::<Text, _>(app.id)
        .bind::<Text, _>(app.id)
        .bind::<Text, _>(cloud.url.as_str())
        .bind::<Text, _>(app.id)
        .get_result(conn),
    }
    .context("read dev app ownership")?;
    Ok(match (counts.registrations, counts.owned_configurations) {
        (0, _) => DevRowOwnership::Absent,
        (_, 0) => DevRowOwnership::Foreign,
        _ => DevRowOwnership::Ours,
    })
}

/// Insert-if-missing then reconcile a single [`DevApp`] — but only when this seed
/// owns the id (see [`DevRowOwnership`]). Split out so each row is its own unit of
/// work: a collision on one dev app never blocks the other.
fn seed_one(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    match ownership(conn, app)? {
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

    // Every statement below is additionally scoped to a payload carrying this
    // seed's ownership marker, so it stays a no-op against a foreign row even if
    // it is ever reached without the check above.
    reconcile(conn, app)
}

/// Write both halves of a fresh dev app: the registration, then its payload.
///
/// A cloud dev app's payload is written by [`reconcile`] rather than here: its
/// single `url` column needs no collision handling, and routing it through the
/// reconcile is what makes the same statement serve a fresh insert and the
/// in-place conversion of a self-hosted dev row this seed wrote earlier.
fn insert(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    // `position` appends at the tail (`MAX + 1`) exactly like the seed
    // migrations, so it can't collide with the UNIQUE column. `kind` is bound
    // from the row's own `serving`; `requires_tunnel` is 0 for both kinds — a
    // self-hosted row is device-local, and the cloud dev row's origin is loopback
    // too, so `iss={origin}` is reachable without the tunnel.
    diesel::sql_query(
        "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
         SELECT ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations), \
                1, ?, ?, 0, ?, 0 \
          WHERE NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = ?)",
    )
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.kind())
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("insert dev registration")?;

    let DevServing::SelfHosted(self_hosted) = &app.serving else {
        return Ok(());
    };

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
    .bind::<Text, _>(self_hosted.content_folder)
    .bind::<Text, _>(self_hosted.subdomain)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(self_hosted.subdomain)
    .bind::<Text, _>(self_hosted.launch_path)
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
/// restart. `kind` *is* rewritten, which is what converts a dev row this seed
/// wrote under an earlier shape (see [`DevRowOwnership`]).
///
/// For a self-hosted dev app the topology writes skip (rather than fail on) a
/// port or subdomain another app holds; the reclaim happens on a later boot once
/// it frees up.
fn reconcile(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    match &app.serving {
        DevServing::SelfHosted(self_hosted) => reconcile_self_hosted(conn, app, self_hosted),
        DevServing::Cloud(cloud) => reconcile_cloud(conn, app, cloud),
    }
}

/// Reconcile the shared registration columns. Scoped to a payload carrying this
/// seed's marker, so it stays inert against a foreign row; the caller has already
/// established ownership, and this predicate is the belt to that's braces.
fn reconcile_registration(conn: &mut SqliteConnection, app: &DevApp) -> anyhow::Result<()> {
    diesel::sql_query(
        "UPDATE app_registrations \
            SET kind = ?, name = ?, subtitle = ?, local_only = 0, \
                client_id = ?, requires_tunnel = 0 \
          WHERE id = ? \
            AND (EXISTS (SELECT 1 FROM self_hosted_app_configurations \
                          WHERE id = ? AND seeded = 1) \
                 OR EXISTS (SELECT 1 FROM cloud_app_configurations WHERE id = ? AND url = ?))",
    )
    .bind::<Text, _>(app.kind())
    .bind::<Text, _>(app.name)
    .bind::<Text, _>(app.subtitle)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(app.cloud_url().unwrap_or(""))
    .execute(conn)
    .context("reconcile dev registration")?;
    Ok(())
}

/// Pull a cloud dev row onto its launch URL, converting a self-hosted payload
/// this seed wrote earlier if one is still there.
///
/// The delete comes first and is scoped to `seeded = 1`, so it can only ever drop
/// this seed's own payload — never a user's uploaded app (the caller has already
/// refused to touch one). Writing the cloud payload before the registration's
/// `kind` keeps the store readable at every point: `find_app` dispatches on
/// `kind`, so the payload it will look for exists by the time `kind` names it.
fn reconcile_cloud(
    conn: &mut SqliteConnection,
    app: &DevApp,
    cloud: &CloudServing,
) -> anyhow::Result<()> {
    diesel::sql_query("DELETE FROM self_hosted_app_configurations WHERE id = ? AND seeded = 1")
        .bind::<Text, _>(app.id)
        .execute(conn)
        .context("drop the superseded self-hosted payload of a cloud dev app")?;

    // `INSERT OR REPLACE` so a fresh insert and a conversion are one statement.
    // The `EXISTS` guard keeps it FK-safe: the registration is written by
    // `insert` (or already there), and without it a missing registration would
    // fail the foreign key rather than no-op.
    diesel::sql_query(
        "INSERT OR REPLACE INTO cloud_app_configurations (id, url) \
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = ?)",
    )
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(cloud.url.as_str())
    .bind::<Text, _>(app.id)
    .execute(conn)
    .context("reconcile dev cloud configuration")?;

    reconcile_registration(conn, app)
}

/// Pull an already-owned self-hosted dev row back onto its pinned topology.
fn reconcile_self_hosted(
    conn: &mut SqliteConnection,
    app: &DevApp,
    self_hosted: &SelfHostedServing,
) -> anyhow::Result<()> {
    reconcile_registration(conn, app)?;

    diesel::sql_query(
        "UPDATE self_hosted_app_configurations \
            SET content_folder = ?, launch_path = ? \
          WHERE id = ? AND seeded = 1",
    )
    .bind::<Text, _>(self_hosted.content_folder)
    .bind::<Text, _>(self_hosted.launch_path)
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
    .bind::<Text, _>(self_hosted.subdomain)
    .bind::<Text, _>(app.id)
    .bind::<Text, _>(self_hosted.subdomain)
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
    fn seeds_all_dev_rows_on_their_pinned_topology() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        for app in &dev_apps() {
            let registration = match &app.serving {
                DevServing::SelfHosted(self_hosted) => {
                    let (registration, config) = dev_self_hosted(&store, app.id);
                    assert_eq!(i32::from(config.port), app.port);
                    assert_eq!(config.subdomain, self_hosted.subdomain);
                    assert_eq!(config.content_folder, self_hosted.content_folder);
                    assert_eq!(config.launch_path.as_deref(), Some(self_hosted.launch_path));
                    registration
                }
                DevServing::Cloud(cloud) => {
                    let (registration, config) = dev_cloud(&store, app.id);
                    assert_eq!(config.url.to_string(), cloud.url);
                    registration
                }
            };
            assert_eq!(registration.name, app.name);
            // The redirect resolver requires `client_id == id`, and the app's dev
            // build sends exactly this id.
            assert_eq!(registration.client_id.as_deref(), Some(app.id));
            assert!(registration.on_homescreen);
            assert!(!registration.requires_tunnel);
        }
    }

    /// The OHIF dev row is the one cloud dev app: the host must not bind a
    /// listener for it, and its launch URL must name its own loopback dev port
    /// (from the shared ports file) and the `-dev` OAuth client — the only client
    /// registering an absolute redirect on that origin.
    #[test]
    fn the_ohif_dev_row_is_cloud_on_its_loopback_preview_origin() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        seed_dev_apps(pool.clone()).unwrap();
        let store = SqliteAppsStore::new(pool).unwrap();

        let port = dev_apps()
            .iter()
            .find(|app| app.id == "ohif-viewer-dev")
            .expect("the OHIF dev row")
            .port;
        let (registration, config) = dev_cloud(&store, "ohif-viewer-dev");
        assert_eq!(
            config.url.to_string(),
            format!(
                "http://localhost:{port}/fhir-viewer\
                 ?launch={{launch}}&iss={{origin}}/fhir-r4&clientId=ohif-viewer-dev"
            ),
        );
        assert!(
            !registration.requires_tunnel,
            "a loopback dev origin reaches a loopback `iss` without the tunnel",
        );
        assert!(!registration.local_only);
    }

    /// A dev database seeded by an older build holds `ohif-viewer-dev` as a
    /// `seeded = 1` SELF-HOSTED row. That is still this seed's own row, so the
    /// next boot must convert it in place — leaving it stranded as `Foreign`
    /// would mean the tile never became cloud on any existing checkout.
    #[test]
    fn converts_a_previously_self_hosted_ohif_dev_row_to_cloud() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let store = SqliteAppsStore::new(pool.clone()).unwrap();
        let mut conn = pool.get().unwrap();
        // Exactly what the previous shape of this seed wrote.
        diesel::sql_query(
            "INSERT INTO app_registrations \
                 (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) \
             VALUES ('ohif-viewer-dev', 'self-hosted', 100, 1, 'Imaging (Dev)', NULL, 0, \
                     'ohif-viewer-dev', 0)",
        )
        .execute(&mut conn)
        .unwrap();
        let port = dev_apps()
            .iter()
            .find(|app| app.id == "ohif-viewer-dev")
            .expect("the OHIF dev row")
            .port;
        diesel::sql_query(
            "INSERT INTO self_hosted_app_configurations \
                 (id, port, content_folder, subdomain, seeded, launch_path) \
             VALUES ('ohif-viewer-dev', ?, 'ohif-viewer', 'ohif-viewer-dev', 1, \
                     '/?launch={launch}&iss={origin}/fhir-r4')",
        )
        .bind::<Integer, _>(port)
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        seed_dev_apps(pool.clone()).unwrap();

        let (registration, config) = dev_cloud(&store, "ohif-viewer-dev");
        assert_eq!(config.url.to_string(), ohif_viewer_dev_url(port));
        assert_eq!(registration.position, 100, "placement must survive");
        assert_eq!(registration.client_id.as_deref(), Some("ohif-viewer-dev"));
        // The superseded payload must be gone, not merely shadowed: leaving it
        // would keep its port and subdomain reserved against the UNIQUE columns.
        let mut conn = pool.get().unwrap();
        let counts: OwnershipCounts = diesel::sql_query(
            "SELECT 0 AS registrations, \
                    (SELECT COUNT(*) FROM self_hosted_app_configurations \
                      WHERE id = 'ohif-viewer-dev') AS owned_configurations",
        )
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
            match &app.serving {
                DevServing::SelfHosted(self_hosted) => {
                    let (_, config) = dev_self_hosted(&store, app.id);
                    assert_eq!(i32::from(config.port), app.port);
                    assert_eq!(config.subdomain, self_hosted.subdomain);
                }
                DevServing::Cloud(cloud) => {
                    let (_, config) = dev_cloud(&store, app.id);
                    assert_eq!(config.url.to_string(), cloud.url);
                }
            }
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

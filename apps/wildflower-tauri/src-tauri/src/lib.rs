mod api_stubs;
mod bridge;
mod spa;
mod tunnel_adapters;

use anyhow::Context;
use apps_rust::{setup_apps, AppsConfig};
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{
    layer_router_with_gatekeeper_auth_gating, setup_gatekeeper, GatekeeperConfig,
};
use shared_structures_rust::ServerRuntimeConfig;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

// Loopback hostname/port for the embedded API server, derived at compile time
// from the SINGLE SOURCE OF TRUTH
// `apps/wildflower-tauri/tauri-shared-config.json`. `build.rs` reads that file
// and re-emits these as `rustc-env` vars; the TS shell injects the same file
// as `WILDFLOWER_LOOPBACK_ORIGIN` (see `vite.config.ts` and `src/main.tsx`).
// Changing the JSON updates both sides — they can't drift. A non-numeric port
// in the JSON fails this `const` parse at compile time rather than at bind
// time.
const LOOPBACK_HOSTNAME: &str = env!("WILDFLOWER_LOOPBACK_HOSTNAME");
const LOOPBACK_PORT: u16 = match u16::from_str_radix(env!("WILDFLOWER_LOOPBACK_PORT"), 10) {
    Ok(port) => port,
    Err(_) => panic!("WILDFLOWER_LOOPBACK_PORT (from tauri-shared-config.json) must be a u16"),
};

// Filenames of the host's SQLite databases under the shared app-data dir. These
// are the single source of truth for each database's on-disk name: the slice
// that opens it AND the data-management catalogue (`/databases`) reference the
// same const, so adding or renaming a database is one edit here. The host owns
// these names — `databases-rust` has no built-in knowledge of them.
const HEALTH_DATA_DB: &str = "health-data.sqlite";
const WILDFLOWER_DB: &str = "wildflower.sqlite";

async fn run_server(
    runtime: ServerRuntimeConfig,
    publishers: bridge::BridgePublishers,
    app_handle: tauri::AppHandle,
) -> anyhow::Result<()> {
    // Apply any deletions the Owner scheduled from the data-management screen
    // BEFORE opening the databases below: the `/databases` DELETE can't remove a
    // file the owning slice holds open, so it drops a marker that we purge here,
    // while nothing has the file open yet.
    databases_rust::purge_pending_deletions(&runtime.app_data_dir)
        .context("failed to purge scheduled database deletions")?;

    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join(HEALTH_DATA_DB),
    };
    let loopback_host = format!("{}:{}", runtime.loopback_hostname, runtime.loopback_port);
    let loopback_origin = format!(
        "http://{}:{}",
        runtime.loopback_hostname, runtime.loopback_port
    );
    // The host owner token is minted against this loopback origin (the
    // WebView reaches the API over loopback). We bind 127.0.0.1 explicitly
    // (the OS enforces loopback-only at the socket, so LAN peers can't reach
    // the surface even before the loopback gate runs), so the WebView's
    // `Host:` header is `127.0.0.1:<port>` — the same canonical form
    // `served_origin_for` falls back to for un-forwarded requests.
    let gatekeeper_config = GatekeeperConfig {
        loopback_origin: loopback_origin.clone(),
    };

    // One shared SQLite database for all persistence-rust-backed slices
    // (gatekeeper, and the tunnel slice); each runs its own namespaced
    // migrations on it. (The FHIR/emr store is managed separately by
    // helios-persistence.)
    let db = persistence_rust::Connection::open(&runtime.app_data_dir.join(WILDFLOWER_DB))
        .context("failed to open shared database")?;

    // Bind BEFORE minting/publishing the Owner token: `setup_gatekeeper`
    // pushes the freshly-minted token onto the bridge publisher, and the
    // bridge emits a contentless `AuthTokenIssued` notify so the webview
    // pulls via the capability-gated `gatekeeper_current_token` command.
    // If the port were already taken, minting first would mean the next
    // pull would return a full-Owner bearer while a *foreign* process
    // owns `127.0.0.1:<port>`. Binding first guarantees the token is
    // only ever minted once this process owns the port.
    let listener = TcpListener::bind(&loopback_host)
        .await
        .with_context(|| format!("failed to bind to {loopback_host}"))?;

    let fhir_r4_router =
        setup_fhir_r4(&runtime, &emr_config).context("failed to set up FHIR R4 router")?;
    // `setup_gatekeeper` publishes the freshly-minted host owner token
    // through the bridge's publisher; the bridge's resident task emits
    // a contentless `AuthTokenIssued` notify to the webview on every
    // page load and on every token change (the webview pulls the
    // bearer via `gatekeeper_current_token`, which is capability-gated
    // to the main webview). The same task forwards pending
    // device-consent heads (and `null` clears) over
    // `bridge:DeviceConsentRequested` and raises the desktop window on
    // transitions to a pending head (see `bridge::attach_bridge`).
    let gatekeeper = setup_gatekeeper(
        db.clone(),
        &gatekeeper_config,
        &publishers.host_owner_token_sender,
        publishers.active_device_user_code_sender,
    )
    .context("failed to set up gatekeeper")?;

    let gated_fhir_r4 =
        layer_router_with_gatekeeper_auth_gating(fhir_r4_router, gatekeeper.state.clone());

    let gated_stubs = layer_router_with_gatekeeper_auth_gating(
        api_stubs::app_shell_stub_router(),
        gatekeeper.state.clone(),
    );

    // The real `/tunnel` surface (replacing the former api_stubs stub). It's
    // Owner-gated like the rest of the admin API. Settings (incl. the relay
    // connection) are persisted in SQLite and controlled through the API; there
    // is no UI and no env seeding yet, so on a fresh install the relay is
    // unconfigured and toggling the tunnel on just reports that.
    // Build-time tunnel connection defaults, baked into the binary so a
    // reinstall re-seeds them (see `tunnel_rust::TunnelStore::seed_if_absent`,
    // which only fills unconfigured fields). The relay is seeded only when all
    // four fields are present at build time.
    //
    // SECURITY: `WILDFLOWER_TUNNEL_RELAY_TOKEN` is compiled into the distributed
    // binary (an extractable artifact) — an accepted trade-off so the relay
    // connection survives reinstalls, token included, without re-entry.
    fn tunnel_seed_from_build_env() -> tunnel_rust::SettingsSeed {
        // Treat an empty value as absent: a blank `.env` entry is forwarded by
        // `dotenvy` as `Some("")`, which would otherwise seed a half-configured
        // relay (and an empty token reads back as unconfigured anyway).
        let non_empty = |value: &'static str| (!value.is_empty()).then_some(value);
        let relay = match (
            option_env!("WILDFLOWER_TUNNEL_RELAY_REMOTE_ADDR").and_then(non_empty),
            option_env!("WILDFLOWER_TUNNEL_RELAY_TOKEN").and_then(non_empty),
            option_env!("WILDFLOWER_TUNNEL_RELAY_PUBLIC_KEY").and_then(non_empty),
            option_env!("WILDFLOWER_TUNNEL_RELAY_SERVICE_NAME").and_then(non_empty),
        ) {
            (Some(remote_addr), Some(token), Some(public_key), Some(service_name)) => {
                Some(tunnel_rust::RelaySettings {
                    remote_addr: remote_addr.to_owned(),
                    token: token.to_owned(),
                    public_key: public_key.to_owned(),
                    service_name: service_name.to_owned(),
                })
            }
            _ => None,
        };
        tunnel_rust::SettingsSeed {
            public_host: option_env!("WILDFLOWER_TUNNEL_PUBLIC_HOST")
                .and_then(non_empty)
                .map(str::to_owned),
            relay,
        }
    }

    let tunnel_config = tunnel_rust::TunnelConfig {
        loopback_origin: loopback_origin.clone(),
        local_port: runtime.loopback_port,
        seed: tunnel_seed_from_build_env(),
    };
    // `setup_tunnel` hands back the `/tunnel` router plus the in-process
    // `TunnelControl` seam (which implements `TunnelService`). The daemon drives
    // a `/health` probe — against the app-layer `/health` route mounted below —
    // through the reqwest adapter to verify reachability.
    let health_probe: Arc<dyn tunnel_rust::HealthProbe> =
        Arc::new(tunnel_adapters::ReqwestHealthProbe::new());
    let tunnel = tunnel_rust::setup_tunnel(db.clone(), &tunnel_config, health_probe)
        .context("failed to set up tunnel")?;
    let gated_tunnel =
        layer_router_with_gatekeeper_auth_gating(tunnel.router, gatekeeper.state.clone());

    // The apps catalogue surface. `GET /apps` (list) and `GET /apps/{id}`
    // (launch redirect) ride on the public router — the webview consumes
    // them unauthenticated like the rest of the launch path. The admin
    // surface (POST/PATCH/DELETE) is owner-gated through the gatekeeper.
    // A `requires_tunnel` launch resolves to the tunnel's verified origin
    // through the tunnel service (else falls back to loopback + tunnel=unavailable).
    let apps_config = AppsConfig {
        loopback_origin: loopback_origin.clone(),
    };
    // `TunnelControl` implements `TunnelService`, so it's handed straight in.
    let tunnel_service: Arc<dyn tunnel_rust::TunnelService> = Arc::new(tunnel.control.clone());
    // Wire the apps `RequestTunnel` web→host bridge handler now that the tunnel
    // service exists: the SPA's launch path asks the host to bring the tunnel up
    // (and awaits the verified origin) for an app that needs a public origin
    // when the tunnel isn't already running.
    bridge::attach_apps_tunnel_bridge(&app_handle, Arc::clone(&tunnel_service));
    let apps = setup_apps(db, &apps_config, tunnel_service).context("failed to set up apps")?;
    let gated_apps_admin =
        layer_router_with_gatekeeper_auth_gating(apps.admin_router, gatekeeper.state.clone());

    // The data-management surface (`/databases`): export + delete the host's
    // SQLite databases. It owns no store — it works at the file level on the
    // same `app_data_dir` the databases above live in — so the host passes the
    // directory plus the catalogue (the slice has no built-in knowledge of which
    // databases exist; the user-facing strings live here). Owner-gated like the
    // rest of the admin API.
    let databases_config = databases_rust::DatabasesConfig {
        data_dir: runtime.app_data_dir.clone(),
        databases: vec![
            databases_rust::DatabaseDescriptor {
                id: HEALTH_DATA_DB.to_owned(),
                label: "Health data".to_owned(),
                description:
                    "Your FHIR clinical records — patients, observations, and the rest of your chart."
                        .to_owned(),
            },
            databases_rust::DatabaseDescriptor {
                id: WILDFLOWER_DB.to_owned(),
                label: "Wildflower app data".to_owned(),
                description: "App state — access grants, tunnel settings, and the apps catalogue."
                    .to_owned(),
            },
        ],
    };
    let gated_databases = layer_router_with_gatekeeper_auth_gating(
        databases_rust::setup_databases(&databases_config),
        gatekeeper.state.clone(),
    );
    // The webview page is NOT served from this origin — it loads from
    // the Vite dev server (`http://localhost:1420`) in dev and Tauri's
    // asset protocol (`tauri://localhost`) in builds, while API fetches
    // target this server absolutely (the React tauri entry's
    // `apiBaseUrl`). So every API request is cross-origin and the API
    // must impose no CORS restriction. `very_permissive()` mirrors the
    // requesting origin/method/headers back (rather than `*`, whose
    // header wildcard the CORS spec defines as excluding
    // `Authorization` — the one header the bearer clients need).
    // Trust doesn't come from CORS here anyway: the loopback gate
    // rejects non-local peers and auth rides the bearer header.
    let router = Router::new()
        .merge(gatekeeper.router)
        .merge(gated_fhir_r4)
        .merge(gated_stubs)
        .merge(gated_tunnel)
        // The app-layer `/health`: an unauthenticated liveness endpoint the
        // tunnel's reachability probe round-trips through the relay. Ungated so
        // the probe (and any external uptime check) needs no bearer token. The
        // reusable router comes from the core; `AlwaysHealthy` is the trivial
        // service until real per-slice checks are wired.
        .merge(shared_structures_rust::health_check::health_router(
            Arc::new(shared_structures_rust::health_check::AlwaysHealthy),
        ))
        .merge(apps.public_router)
        .merge(gated_apps_admin)
        .merge(gated_databases)
        .fallback(spa::handle_serving_spa_html)
        .layer(CorsLayer::very_permissive());

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// Build and run the Tauri application.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to start — an unrecoverable
/// windowing/context failure with no app handle through which to surface a
/// dialog, so dying with the error is the honest outcome. Recoverable startup
/// failures (e.g. the app-data directory) are handled inside `.setup()` where a
/// handle still exists.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bridge::gatekeeper_current_token])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Native web view popup, presenting external URLs with native chrome
        // and document-start JS injection — the native counterpart to the
        // browser-sniffer WebviewWindow path, which stays in place. iOS uses a
        // WKWebView, Android an android.webkit.WebView, desktop a Tauri
        // WebviewWindow (scoped by capabilities/native-webview-window.json).
        .plugin(tauri_plugin_native_webview::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Stdout only — no Webview target, so host logs never
                // re-enter the webview. Keeps the log flow one-way:
                // webview console → `bridge:Log` → here (a Webview
                // target would loop those right back out).
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .level(tauri_plugin_log::log::LevelFilter::Debug)
                // rathole logs every relay heartbeat/data-channel event at
                // debug — far too repetitive to read the tunnel lifecycle
                // through. Pin it to info; the tunnel slice's own
                // dial/probe/transition logs carry the timeline we care about.
                .level_for("rathole", tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            // Attach the bridge before the server task spawns: `listen`
            // registers synchronously, so the webview's `__Ready` (which
            // fires much later, once the bundle runs) can't be missed
            // even if the server is slow to boot. The bridge owns its
            // channel plumbing; the server task gets the publishers.
            let publishers = bridge::attach_bridge(app.handle());

            // Wire the CollectorBridge.webToHost listeners that manage the
            // sniffer child webview lifecycle (open / navigate / close).
            // Sniffer-emitted data-plane events (`bridge:ResponseStart`
            // etc.) reach the React SPA directly via the global Tauri
            // event bus — no Rust forwarding is needed for them.
            browser_sniffer_tauri_rust::attach_browser_sniffer(app.handle());

            let error_handle = app.handle().clone();
            // The server task wires the apps `RequestTunnel` bridge handler once
            // the tunnel service is built, so it needs an app handle to listen
            // on / emit through the bridge event bus.
            let server_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let runtime = ServerRuntimeConfig {
                    // Loopback-only: the OS rejects non-local peers at the
                    // socket, so the bearer secret is never the only thing
                    // between LAN peers and FHIR health data. Hostname/port
                    // come from the shared `tauri-shared-config.json` (see
                    // `LOOPBACK_HOSTNAME`/`LOOPBACK_PORT`), the same file the
                    // TS `apiBaseUrl` reads.
                    loopback_hostname: LOOPBACK_HOSTNAME.to_string(),
                    loopback_port: LOOPBACK_PORT,
                    app_data_dir,
                };

                if let Err(error) = run_server(runtime, publishers, server_handle).await {
                    tauri_plugin_log::log::error!("Wildflower server stopped: {error:?}");
                    // A failed/stopped server leaves the webview unable to
                    // reach the API at all (no token, no FHIR) — surface it
                    // with a native dialog instead of dying silently in the
                    // logs. A native dialog (not a webview message) is used
                    // deliberately: it shows even when the webview itself can't
                    // load. Blocking is fine here — the server is already dead.
                    error_handle
                        .dialog()
                        .message(format!("Wildflower server stopped: {error:#}"))
                        .kind(MessageDialogKind::Error)
                        .title("Wildflower")
                        .blocking_show();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

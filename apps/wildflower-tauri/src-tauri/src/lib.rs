mod api_stubs;
mod bridge;
mod spa;

use anyhow::Context;
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{
    layer_router_with_gatekeeper_auth_gating, setup_gatekeeper, GatekeeperConfig,
};
use shared_structures_rust::ServerRuntimeConfig;
use std::net::SocketAddr;
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

async fn run_server(
    runtime: ServerRuntimeConfig,
    publishers: bridge::BridgePublishers,
) -> anyhow::Result<()> {
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join("health-data.sqlite"),
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
        db_file_path: runtime.app_data_dir.join("gatekeeper.sqlite"),
        loopback_origin: loopback_origin.clone(),
    };

    // Bind BEFORE minting/publishing the Owner token: `setup_gatekeeper`
    // pushes the freshly-minted token onto the bridge publisher, and the
    // bridge emits `AuthTokenIssued` to the webview. If the port were
    // already taken, minting first would hand a full-Owner bearer to the
    // webview while a *foreign* process owns `127.0.0.1:<port>`. Binding
    // first guarantees the token is only ever minted once this process
    // owns the port.
    let listener = TcpListener::bind(&loopback_host)
        .await
        .with_context(|| format!("failed to bind to {loopback_host}"))?;

    let fhir_r4_router =
        setup_fhir_r4(&runtime, &emr_config).context("failed to set up FHIR R4 router")?;
    // `setup_gatekeeper` publishes the freshly-minted host owner token
    // through the bridge's publisher; the bridge's resident task emits
    // `AuthTokenIssued` to the webview on every page load and on every
    // token change (see `bridge::attach_bridge`).
    let gatekeeper = setup_gatekeeper(&gatekeeper_config, &publishers.host_owner_token_sender)
        .context("failed to set up gatekeeper")?;

    let gated_fhir_r4 =
        layer_router_with_gatekeeper_auth_gating(fhir_r4_router, gatekeeper.state.clone());

    let gated_stubs = layer_router_with_gatekeeper_auth_gating(
        api_stubs::app_shell_stub_router(&loopback_origin),
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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

            let error_handle = app.handle().clone();
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

                if let Err(error) = run_server(runtime, publishers).await {
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

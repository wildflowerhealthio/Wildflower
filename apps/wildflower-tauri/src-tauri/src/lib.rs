mod api_stubs;
mod bridge;

use anyhow::Context;
use axum::{response::Html, Router};
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{
    layer_router_with_gatekeeper_auth_gating, setup_gatekeeper, GatekeeperConfig,
};
use shared_structures_rust::ServerRuntimeConfig;
use std::net::SocketAddr;
use tauri::Manager;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

// Loopback host/port for the embedded API server, derived at compile
// time from the SINGLE SOURCE OF TRUTH `apps/wildflower-tauri/api-origin.json`.
// `build.rs` reads that file and re-emits these as `rustc-env` vars; the
// TS shell injects the same file as `__API_ORIGIN__` (see `vite.config.ts`
// and `src/main.tsx`). Changing the JSON updates both sides — they can't
// drift. A non-numeric port in the JSON fails this `const` parse at compile
// time rather than at bind time.
const API_HOST: &str = env!("WILDFLOWER_API_HOST");
const API_PORT: u16 = match u16::from_str_radix(env!("WILDFLOWER_API_PORT"), 10) {
    Ok(port) => port,
    Err(_) => panic!("WILDFLOWER_API_PORT (from api-origin.json) must be a u16"),
};

// Embedded at compile time so the bundle ships inside the binary: a
// runtime file read keyed off `CARGO_MANIFEST_DIR` resolves to the
// build machine's absolute path, which doesn't exist on an installed
// app, so external-browser OAuth/consent flows (served the `/_auth/*`
// shell) would degrade to the failure page in every production build.
// `include_str!` resolves relative to this source file; the single-file
// `build:single-web` bundle is produced before the crate compiles, so
// one embedded string covers the whole shell. A build that skipped the
// bundle step fails to compile here rather than shipping a broken app.
const SPA_INDEX_HTML: &str =
    include_str!("../../../wildflower-react/dist-single-web/index-single-web.html");

async fn serve_spa_fallback() -> Html<&'static str> {
    Html(SPA_INDEX_HTML)
}

async fn run_server(
    runtime: ServerRuntimeConfig,
    publishers: bridge::BridgePublishers,
) -> anyhow::Result<()> {
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join("health-data.sqlite"),
    };
    let gatekeeper_config = GatekeeperConfig {
        db_file_path: runtime.app_data_dir.join("gatekeeper.sqlite"),
    };

    let addr = format!("{}:{}", runtime.host, runtime.port);

    // Pin the host owner token to the loopback origin the WebView uses.
    // We bind 127.0.0.1 explicitly (the OS enforces loopback-only at the
    // socket, so LAN peers can't reach the surface even before the
    // loopback gate runs), so the WebView's `Host:` header is
    // `127.0.0.1:<port>` — the verifier derives the expected
    // issuer/audience from that header, so the token has to be minted
    // against the same canonical form.
    let token_origin = format!("http://127.0.0.1:{}", runtime.port);

    // Bind BEFORE minting/publishing the Owner token: `setup_gatekeeper`
    // pushes the freshly-minted token onto the bridge publisher, and the
    // bridge emits `AuthTokenIssued` to the webview. If the port were
    // already taken, minting first would hand a full-Owner bearer to the
    // webview while a *foreign* process owns `127.0.0.1:<port>`. Binding
    // first guarantees the token is only ever minted once this process
    // owns the port.
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind to {addr}"))?;

    let fhir_r4_router =
        setup_fhir_r4(&runtime, &emr_config).context("failed to set up FHIR R4 router")?;
    // `setup_gatekeeper` publishes the freshly-minted host owner token
    // through the bridge's publisher; the bridge's resident task emits
    // `AuthTokenIssued` to the webview on every page load and on every
    // token change (see `bridge::attach_bridge`).
    let gatekeeper = setup_gatekeeper(
        &gatekeeper_config,
        &token_origin,
        &publishers.host_owner_token_sender,
    )
    .context("failed to set up gatekeeper")?;

    let gated_fhir_r4 =
        layer_router_with_gatekeeper_auth_gating(fhir_r4_router, gatekeeper.state.clone());

    let gated_stubs = layer_router_with_gatekeeper_auth_gating(
        api_stubs::app_shell_stub_router(runtime.port),
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
        .fallback(serve_spa_fallback)
        .layer(CorsLayer::very_permissive());

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
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
                    // between LAN peers and FHIR health data. Host/port come
                    // from the shared `api-origin.json` (see `API_HOST`/
                    // `API_PORT`), the same file the TS `apiBaseUrl` reads.
                    host: API_HOST.to_string(),
                    port: API_PORT,
                    app_data_dir,
                };

                if let Err(error) = run_server(runtime, publishers).await {
                    tauri_plugin_log::log::error!("Wildflower server stopped: {error:?}");
                    // A failed/stopped server leaves the webview unable to
                    // reach the API at all (no token, no FHIR) — surface it
                    // to the user instead of dying silently in the logs.
                    // `bridge::FATAL_ERROR_EVENT` carries a human-readable
                    // message the shell renders; we emit an event rather
                    // than add a dialog-plugin dependency.
                    bridge::emit_fatal_error(
                        &error_handle,
                        &format!("Wildflower server stopped: {error:#}"),
                    );
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

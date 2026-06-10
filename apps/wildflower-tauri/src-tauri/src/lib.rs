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

// Resolved at compile time from this crate's manifest dir; the file itself
// is read per request so a missing bundle degrades to the failure page
// instead of refusing to boot.
const SPA_INDEX_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../wildflower-react/dist-single-web/index-single-web.html"
);

const SPA_FAILURE_HTML: &str =
    "<!doctype html><title>Wildflower</title><h1>SPA bundle not found</h1>";

async fn serve_spa_fallback() -> Html<String> {
    match tokio::fs::read_to_string(SPA_INDEX_PATH).await {
        Ok(html) => Html(html),
        Err(_) => Html(SPA_FAILURE_HTML.to_string()),
    }
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
    // We bind 0.0.0.0 (any interface) but every reachable client we accept
    // is loopback (the loopback gate rejects the rest), so the WebView's
    // `Host:` header is `127.0.0.1:<port>` — the verifier derives the
    // expected issuer/audience from that header, so the token has to be
    // minted against the same canonical form.
    let token_origin = format!("http://127.0.0.1:{}", runtime.port);

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

    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind to {addr}"))?;
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

            tauri::async_runtime::spawn(async move {
                let runtime = ServerRuntimeConfig {
                    host: "0.0.0.0".to_string(),
                    port: 8080,
                    app_data_dir,
                };

                if let Err(error) = run_server(runtime, publishers).await {
                    tauri_plugin_log::log::error!("Wildflower server stopped: {error:?}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use anyhow::Context;
use axum::Router;
use chrono::Duration;
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{gate, mint_host_owner_token, setup_gatekeeper, GatekeeperConfig};
use shared_structures_rust::ServerRuntimeConfig;
use std::net::SocketAddr;
use tauri::Manager;
use tokio::net::TcpListener;

async fn run_server(runtime: ServerRuntimeConfig) -> anyhow::Result<()> {
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join("health-data.sqlite"),
    };
    let gatekeeper_config = GatekeeperConfig {
        db_file_path: runtime.app_data_dir.join("gatekeeper.sqlite"),
    };

    let addr = format!("{}:{}", runtime.host, runtime.port);

    let fhir_r4_router =
        setup_fhir_r4(&runtime, &emr_config).context("failed to set up FHIR R4 router")?;
    let gatekeeper =
        setup_gatekeeper(&gatekeeper_config).context("failed to set up gatekeeper")?;

    ensure_local_owner_token(&gatekeeper, runtime);

    let gated_fhir_r4 = gate(fhir_r4_router, gatekeeper.state.clone());
    let router = Router::new().merge(gatekeeper.router).merge(gated_fhir_r4);

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

fn ensure_local_owner_token(gatekeeper: &gatekeeper_rust::Gatekeeper, runtime: ServerRuntimeConfig) {
    // Pin the host owner token to the loopback origin the WebView uses.
    // We bind 0.0.0.0 (any interface) but every reachable client we accept
    // is loopback (the loopback gate rejects the rest), so the WebView's
    // `Host:` header is `127.0.0.1:<port>` — the verifier derives the
    // expected issuer/audience from that header, so the token has to be
    // minted against the same canonical form.
    // TODO(transport): ship this token to the WebView via the navigation
    // bridge (today only logged for debugging).
    let mint_origin = format!("http://127.0.0.1:{}", runtime.port);
    match mint_host_owner_token(&gatekeeper.state, &mint_origin, Duration::hours(24)) {
        Ok(token) => {
            tauri_plugin_log::log::info!(
                "Local client token minted (prefix: {}…)",
                &token[..token.len().min(8)]
            );
        }
        Err(error) => {
            tauri_plugin_log::log::error!("Local client token unavailable: {error:?}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(tauri_plugin_log::log::LevelFilter::Debug)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            tauri::async_runtime::spawn(async move {
                let runtime = ServerRuntimeConfig {
                    host: "0.0.0.0".to_string(),
                    port: 8080,
                    app_data_dir,
                };

                if let Err(error) = run_server(runtime).await {
                    tauri_plugin_log::log::error!("Wildflower server stopped: {error:?}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

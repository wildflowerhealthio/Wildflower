use anyhow::Context;
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use shared_structures_rust::ServerRuntimeConfig;
use tauri::Manager;
use tokio::net::TcpListener;

async fn run_server(runtime: ServerRuntimeConfig) -> anyhow::Result<()> {
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join("health-data.sqlite"),
    };

    let addr = format!("{}:{}", runtime.host, runtime.port);
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind to {addr}"))?;
    let fhir_r4_router =
        setup_fhir_r4(&runtime, &emr_config).context("failed to set up FHIR R4 router")?;
    let router = Router::new().merge(fhir_r4_router);
    axum::serve(listener, router.into_make_service()).await?;
    Ok(())
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

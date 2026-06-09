use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use tauri::Manager;
use tokio::net::TcpListener;

async fn serve(addr: String, fhir_r4_router: Router) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    let router = Router::new().nest("/fhir-r4", fhir_r4_router);
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
            let db_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&db_dir)?;

            let config = EmrConfig {
                host: "0.0.0.0".to_string(),
                log_level: "debug".to_string(),
                path: "/fhir-r4".to_string(),
                port: 8080,
                db_file_path: db_dir.join("helios.sqlite"),
            };

            let addr = format!("{}:{}", config.host, config.port);
            let fhir_r4_router = setup_fhir_r4(config)?;

            tauri::async_runtime::spawn(async move {
                if let Err(error) = serve(addr, fhir_r4_router).await {
                    tauri_plugin_log::log::error!("Helios server stopped: {error:?}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

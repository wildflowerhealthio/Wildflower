use helios_persistence::backends::sqlite::SqliteBackend;
use helios_rest::{create_app_with_config, ServerConfig};
use tauri::Manager;
use tauri_plugin_fs::FsExt;
use tokio::net::TcpListener;

async fn hfs_server(db_file_path: std::path::PathBuf) -> anyhow::Result<()> {
    // Create a storage backend
    let backend = SqliteBackend::open(db_file_path)?;
    backend.init_schema()?;

    // Configure the server
    let mut config = ServerConfig::default();
    config.base_url = "http://0.0.0.0:8080".to_string();
    config.host = "0.0.0.0".to_string();
    config.log_level = "trace".to_string();
    // Create the Axum application
    let app = create_app_with_config(backend, config.clone());

    // Start the server
    let listener = TcpListener::bind(config.socket_addr()).await?;
    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(tauri_plugin_log::log::LevelFilter::Trace)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let db_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            // allowed the given directory
            let scope = app.fs_scope();
            scope.allow_directory(db_dir.clone(), false)?;
            dbg!(scope.is_allowed(db_dir.clone()));
            std::fs::create_dir_all(&db_dir)?;

            let db_file_path = db_dir.join("helios.sqlite");
            tauri::async_runtime::spawn(hfs_server(db_file_path));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::path::PathBuf;

use axum::routing::Router;
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_rest::{create_app_with_config, ServerConfig};

#[derive(Debug, Clone)]
pub struct EmrConfig {
    pub host: String,
    pub log_level: String,
    pub path: String,
    pub port: u16,
    pub db_file_path: PathBuf,
}

pub fn setup_fhir_r4(config: EmrConfig) -> std::result::Result<Router, Box<dyn std::error::Error>> {
    let sqlite_backend = SqliteBackend::open(&config.db_file_path)?;
    sqlite_backend.init_schema()?;

    let mut server_config = ServerConfig::default();
    server_config.base_url = format!("http://{}:{}{}", config.host, config.port, config.path);
    server_config.host = config.host;
    server_config.log_level = config.log_level;

    Ok(create_app_with_config(sqlite_backend, server_config))
}

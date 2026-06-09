use std::path::PathBuf;

use anyhow::Context;
use axum::routing::Router;
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_rest::{create_app_with_config, ServerConfig};
use shared_structures_rust::ServerRuntimeConfig;

const FHIR_R4_PATH: &str = "/fhir-r4";

#[derive(Debug, Clone)]
pub struct EmrConfig {
    pub log_level: String,
    pub db_file_path: PathBuf,
}

pub fn setup_fhir_r4(runtime: &ServerRuntimeConfig, config: &EmrConfig) -> anyhow::Result<Router> {
    let sqlite_backend = SqliteBackend::open(&config.db_file_path)
        .with_context(|| format!("failed to open sqlite backend at {:?}", config.db_file_path))?;
    sqlite_backend
        .init_schema()
        .context("failed to init sqlite schema")?;

    let server_config = ServerConfig {
        base_url: format!("http://{}:{}{}", runtime.host, runtime.port, FHIR_R4_PATH),
        host: runtime.host.clone(),
        log_level: config.log_level.clone(),
        ..ServerConfig::default()
    };

    Ok(Router::new().nest(
        FHIR_R4_PATH,
        create_app_with_config(sqlite_backend, server_config),
    ))
}

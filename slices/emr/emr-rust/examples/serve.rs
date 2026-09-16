//! Dev-only: stands up the FHIR R4 router on 127.0.0.1:8080 against a
//! throwaway sqlite db so the HFS-served endpoints (`/fhir-r4/metadata`,
//! `/fhir-r4/.well-known/smart-configuration`, etc.) can be curl'd without
//! booting the Tauri shell. Delete once HFS integration is validated end-to-end.

use anyhow::Context;
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use shared_structures_rust::ServerRuntimeConfig;
use std::net::SocketAddr;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let tmp = std::env::temp_dir().join("emr-rust-serve");
    std::fs::create_dir_all(&tmp).context("create temp dir")?;

    let runtime = ServerRuntimeConfig {
        loopback_base_url: "http://127.0.0.1:8080".parse()?,
        app_data_dir: tmp.clone(),
    };
    let config = EmrConfig {
        log_level: "info".to_string(),
        db_file_path: tmp.join("health-data.sqlite"),
        // Dev binary: HFS auth off. Discovery + /metadata still served;
        // anything that would normally require auth (Patient, etc.) is open.
        jwks_url: None,
        // The SearchParameter bundle is a deployed asset; point HFS at the
        // crate's vendored copy so searches index (see `assets/README.md`).
        search_parameter_data_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets"),
    };

    // Dev binary: HFS auth is off (jwks_url is None), so the revocation store is
    // never consulted — the always-allow double satisfies the signature.
    let revocation_store = token_revocation_rust::RevocationStore::always_allow();
    let routers = setup_fhir_r4(&runtime, &config, revocation_store)?;
    let router = Router::new()
        .merge(routers.fhir_r4)
        .merge(ohif_server_rust::setup_ohif_server(routers.hfs_router));
    let addr: SocketAddr = runtime
        .loopback_base_url_ref()
        .authority()
        .parse()
        .context("parse bind addr")?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    eprintln!("emr-rust serve (dev): http://{addr}");
    axum::serve(listener, router).await?;
    Ok(())
}

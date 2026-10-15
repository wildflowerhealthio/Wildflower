//! Dev-only: stands up the FHIR R4 router on 127.0.0.1:8080 against a
//! throwaway sqlite db so the HFS-served endpoints (`/metadata`,
//! `/.well-known/smart-configuration`, etc.) can be curl'd without
//! booting the Tauri shell. Delete once HFS integration is validated end-to-end.

use anyhow::Context;
use axum::Router;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use wildflowerhealthio_fhir_r4::{setup_fhir_r4, ui_login_config, FhirR4Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let tmp = std::env::temp_dir().join("fhir-r4-rust-serve");
    std::fs::create_dir_all(&tmp).context("create temp dir")?;

    let config = FhirR4Config {
        log_level: "info".to_string(),
        db_file_path: tmp.join("health-data.sqlite"),
        bulk_export_dir: tmp.join("fhir-exports"),
        // The SearchParameter bundle is a deployed asset; point HFS at the
        // crate's vendored copy so searches index (see `assets/README.md`).
        search_parameter_data_dir: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets"),
        // Dev binary: no relay, so HFS's links point back at the address
        // it binds below.
        public_origin: "http://127.0.0.1:8080".parse()?,
        authorization_app_base:
            wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase::parse(
                "https://wildflowerhealth.io/authorization/",
            )?,
    };

    let routers = setup_fhir_r4(
        &config,
        // Dev binary: HFS auth off. Discovery + /metadata are served as
        // ever; anything that would normally require auth (Patient, etc.) is
        // open.
        None,
        ui_sessions(&config),
        // No host gate in front: these drive HFS and the UI directly.
        tower::layer::util::Identity::new(),
    )?;
    // Runs `$export`'s jobs for as long as the dev server runs.
    tokio::spawn(
        routers
            .bulk_export_worker
            .run(tokio_util::sync::CancellationToken::new()),
    );
    let router = Router::new().merge(routers.augmented_fhir_r4_router).merge(
        wildflowerhealthio_ohif_server::setup_ohif_server(routers.raw_hfs_router),
    );
    let addr: SocketAddr = config
        .public_origin
        .authority()
        .parse()
        .context("parse bind addr")?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    eprintln!("fhir-r4-rust serve (dev): http://{addr}");
    axum::serve(listener, router).await?;
    Ok(())
}

/// The web UI's session store `setup_fhir_r4` takes, as the host builds it.
fn ui_sessions(config: &FhirR4Config) -> std::sync::Arc<helios_auth::SessionStore> {
    std::sync::Arc::new(helios_auth::SessionStore::new(ui_login_config(
        &config.public_origin,
        "fhir-ui-client",
    )))
}

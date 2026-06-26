//! emr-rust is a thin embedding of [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs)
//! as the FHIR R4 backend. It opens a sqlite store, mounts HFS's Axum router
//! at `/fhir-r4/*`, overrides the SMART discovery doc with a
//! SMART-App-Launch-shaped one, and (optionally) wires HFS's bearer-JWT
//! auth + SMART v2 scope policy against gatekeeper's JWKS.

mod auth;
mod config;
mod smart_configuration;

use anyhow::Context;
use axum::routing::{get, Router};
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_rest::{create_app_with_auth, ServerConfig};
use shared_structures_rust::ServerRuntimeConfig;

use crate::auth::build_auth;
use crate::smart_configuration::{smart_configuration_handler, SmartConfigState};

pub use crate::config::EmrConfig;

const FHIR_R4_PATH: &str = "/fhir-r4";

/// Paths under [`FHIR_R4_PATH`] that a gating layer mounted above
/// [`setup_fhir_r4`]'s router must let through without a bearer token: the FHIR
/// capabilities statement and the discovery docs a client fetches *before* it
/// holds a token. Mirrors HFS's own `EXEMPT_PATHS` (helios-rest's
/// `middleware/auth.rs`), prefixed with [`FHIR_R4_PATH`] — HFS already exempts
/// these from its own auth, but the host's bearer gate above us must be told.
pub const UNAUTHENTICATED_FHIR_PATHS: &[&str] = &[
    "/fhir-r4/metadata",
    "/fhir-r4/.well-known/smart-configuration",
    "/fhir-r4/$versions",
    "/fhir-r4/health",
    "/fhir-r4/_liveness",
    "/fhir-r4/_readiness",
];

/// Build the FHIR R4 [`Router`], opening the sqlite backend and initializing
/// its schema.
///
/// The router serves HFS at `/fhir-r4/*` with one override:
/// `/fhir-r4/.well-known/smart-configuration` is handled locally so we can
/// advertise the SMART App Launch grant + gatekeeper's authorize/token URLs,
/// which HFS's built-in (Backend-Services-shaped) discovery doc doesn't.
///
/// When [`EmrConfig::auth`] is `Some`, HFS auth is enabled: it validates the
/// JWT against the configured JWKS, enforces `iss`, parses SMART v2 scopes,
/// and gates each FHIR operation against them. The discovery override and
/// HFS's `/metadata` remain unauthenticated per the SMART spec.
///
/// # Errors
///
/// Returns an error if the sqlite backend cannot be opened at the configured
/// path or if initializing its schema fails.
pub fn setup_fhir_r4(runtime: &ServerRuntimeConfig, config: &EmrConfig) -> anyhow::Result<Router> {
    let sqlite_backend = SqliteBackend::open(&config.db_file_path).with_context(|| {
        format!(
            "failed to open sqlite backend at {}",
            config.db_file_path.display()
        )
    })?;
    sqlite_backend
        .init_schema()
        .context("failed to init sqlite schema")?;

    let loopback_origin = format!(
        "http://{}:{}",
        runtime.loopback_hostname, runtime.loopback_port
    );

    let server_config = ServerConfig {
        base_url: format!("{loopback_origin}{FHIR_R4_PATH}"),
        // The host param only expects the ip to bind to
        host: runtime.loopback_hostname.clone(),
        log_level: config.log_level.clone(),
        ..ServerConfig::default()
    };

    let (auth_config, auth_state) = build_auth(config.jwks_url.as_deref());
    let hfs_router = create_app_with_auth(
        sqlite_backend,
        server_config,
        auth_config,
        auth_state,
        // Audit middleware: we don't write FHIR audit events from inside
        // emr-rust today; the gatekeeper gating layer above us handles
        // owner/admin access auditing separately.
        None,
    );

    // Specific route wins over fallback: our SMART App Launch discovery doc
    // intercepts the path; everything else under /fhir-r4 falls through to
    // HFS.
    let fhir_with_override = Router::new()
        .route(
            "/.well-known/smart-configuration",
            get(smart_configuration_handler),
        )
        .with_state(SmartConfigState { loopback_origin })
        .fallback_service(hfs_router);

    Ok(Router::new().nest(FHIR_R4_PATH, fhir_with_override))
}

#[cfg(test)]
mod tests {
    use super::{FHIR_R4_PATH, UNAUTHENTICATED_FHIR_PATHS};

    #[test]
    fn unauthenticated_paths_live_under_the_fhir_prefix() {
        for path in UNAUTHENTICATED_FHIR_PATHS {
            assert!(
                path.starts_with(FHIR_R4_PATH),
                "{path} must live under {FHIR_R4_PATH}"
            );
        }
    }

    #[test]
    fn unauthenticated_paths_cover_smart_discovery() {
        assert!(UNAUTHENTICATED_FHIR_PATHS.contains(&"/fhir-r4/metadata"));
        assert!(UNAUTHENTICATED_FHIR_PATHS.contains(&"/fhir-r4/.well-known/smart-configuration"));
    }
}

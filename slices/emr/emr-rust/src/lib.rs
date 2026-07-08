//! emr-rust is a thin embedding of [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs)
//! as the FHIR R4 backend. It opens a sqlite store, mounts HFS's Axum router
//! at `/fhir-r4/*`, overrides the SMART discovery doc with a
//! SMART-App-Launch-shaped one, adds the `$everything` operation HFS lacks, and
//! (optionally) wires HFS's bearer-JWT auth + SMART v2 scope policy against
//! gatekeeper's JWKS.

mod auth;
mod config;
mod patient_everything;
mod smart_configuration;

use anyhow::Context;
use axum::routing::{get, Router};
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_rest::{create_app_with_auth, ServerConfig};
use shared_structures_rust::ServerRuntimeConfig;

use crate::auth::build_auth;
use crate::patient_everything::{patient_everything_handler, EverythingState};
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
/// The router serves HFS at `/fhir-r4/*` with two overrides mounted ahead of
/// it:
/// - `/fhir-r4/.well-known/smart-configuration` is handled locally so we can
///   advertise the SMART App Launch grant + gatekeeper's authorize/token URLs,
///   which HFS's built-in (Backend-Services-shaped) discovery doc doesn't.
/// - `/fhir-r4/Patient/{id}/$everything` implements the FHIR `$everything`
///   operation HFS doesn't ship, by delegating back into HFS's `read` +
///   `Observation` search in-process (see [`patient_everything`]).
///
/// When [`EmrConfig::jwks_url`] is `Some`, HFS auth is enabled: it validates the
/// JWT against the configured JWKS, enforces `iss`, parses SMART v2 scopes,
/// and gates each FHIR operation against them. The discovery override and
/// HFS's `/metadata` remain unauthenticated per the SMART spec — see
/// [`UNAUTHENTICATED_FHIR_PATHS`].
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

    let loopback_base_url = runtime.loopback_base_url();
    // The FHIR base URL is `<bare origin><FHIR_R4_PATH>` (e.g.
    // `http://127.0.0.1:8080/fhir-r4`): take the origin without the `Url`'s
    // trailing slash so the path isn't doubled.
    let loopback_origin = loopback_base_url.origin().ascii_serialization();

    let server_config = ServerConfig {
        base_url: format!("{loopback_origin}{FHIR_R4_PATH}"),
        // The host param only expects the ip to bind to
        host: runtime
            .loopback_base_url_ref()
            .host()
            .expect("loopback_base_url must have host")
            .to_string(),
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

    // Specific routes win over fallback: our SMART App Launch discovery doc and
    // the `$everything` operation intercept their paths; everything else under
    // /fhir-r4 falls through to HFS. Each override sub-router carries its own
    // state, so they're merged after `.with_state` erases the state type.
    let smart_config_route = Router::new()
        .route(
            "/.well-known/smart-configuration",
            get(smart_configuration_handler),
        )
        .with_state(SmartConfigState {
            loopback_base_url: loopback_base_url.clone(),
        });

    // `$everything` delegates back into HFS in-process (see
    // [`patient_everything`]), so it holds a clone of `hfs_router`; the original
    // stays the fallback for every other FHIR path.
    let everything_route = Router::new()
        .route("/Patient/{id}/$everything", get(patient_everything_handler))
        .with_state(EverythingState {
            hfs_router: hfs_router.clone(),
            loopback_base_url,
        });

    let fhir_with_override = smart_config_route
        .merge(everything_route)
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

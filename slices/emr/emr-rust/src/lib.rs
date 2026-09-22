//! emr-rust is a thin embedding of [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs)
//! as the FHIR R4 backend. It opens a sqlite store, mounts HFS's Axum router
//! at `/fhir-r4/*`, overrides the SMART discovery doc with a
//! SMART-App-Launch-shaped one, adds the `$everything` operation HFS lacks, and
//! (optionally) wires HFS's bearer-JWT auth + SMART v2 scope policy against
//! gatekeeper's JWKS.

mod auth;
mod config;
mod delegate;
mod openapi;
mod patient_everything;
mod smart_configuration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, Router};
use helios_persistence::backends::sqlite::{SqliteBackend, SqliteBackendConfig};
use helios_rest::{create_app_with_auth, ServerConfig};
use shared_structures_rust::ServerRuntimeConfig;

use token_revocation_rust::RevocationStore;

use crate::auth::build_auth;
use crate::patient_everything::{patient_everything_handler, EverythingState};
use crate::smart_configuration::{smart_configuration_handler, SmartConfigState};

pub use crate::config::EmrConfig;
pub use crate::openapi::openapi_spec;

const FHIR_R4_PATH: &str = "/fhir-r4";
const MAX_FHIR_BODY_BYTES: usize = 1024 * 1024 * 1024; // 1 GiB

/// Result of [`setup_fhir_r4`]: the augmented FHIR R4 router and the bare HFS
/// router for in-process delegation by other slices.
pub struct FhirR4Routers {
    pub augmented_fhir_r4_router: Router,
    pub raw_hfs_router: Router,
}

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
///   operation HFS doesn't ship, by delegating back into HFS's `read` + indexed
///   `subject=` searches in-process (see [`patient_everything`]).
///
/// When [`EmrConfig::jwks_url`] is `Some`, HFS auth is enabled: it validates the
/// JWT against the configured JWKS, enforces `iss`, parses SMART v2 scopes,
/// and gates each FHIR operation against them. The discovery override and
/// HFS's `/metadata` remain unauthenticated per the SMART spec — see
/// [`UNAUTHENTICATED_FHIR_PATHS`].
///
/// `revocation_store` is the shared token-revocation store the host wires into
/// both this and gatekeeper; when auth is enabled, HFS consults it per validated
/// token through a revocation-checking [`AuthProvider`](helios_auth::AuthProvider)
/// wrapper (per-`jti` denylist — defense-in-depth behind gatekeeper's gate). See
/// [`crate::auth`].
///
/// # Errors
///
/// Returns an error if the configured SearchParameter asset directory does not
/// contain the R4 spec bundle, if the sqlite backend cannot be opened at the
/// configured path, or if initializing its schema fails.
pub fn setup_fhir_r4(
    runtime: &ServerRuntimeConfig,
    config: &EmrConfig,
    revocation_store: RevocationStore,
) -> anyhow::Result<FhirR4Routers> {
    // Point HFS's backend at the on-disk FHIR R4 SearchParameter asset directory
    // the host provides (a bundled resource — never embedded in the binary), so
    // HFS registers every standard R4 search parameter and indexes it at write
    // time. Without a real spec dir HFS falls back to a ~9-parameter minimal set
    // and `Observation.subject`-style searches return nothing, so we fail fast if
    // the bundle isn't there rather than silently degrade — see
    // [`EmrConfig::search_parameter_data_dir`] and this crate's
    // `docs/Capability Statement.md`.
    let spec_dir = &config.search_parameter_data_dir;
    let spec_file = spec_dir.join(SEARCH_PARAMETERS_R4_FILENAME);
    if !spec_file.is_file() {
        anyhow::bail!(
            "FHIR R4 SearchParameter bundle not found at {} — the `{}` asset must be \
             deployed and `EmrConfig::search_parameter_data_dir` must point at its directory",
            spec_file.display(),
            SEARCH_PARAMETERS_R4_FILENAME,
        );
    }
    let sqlite_backend = SqliteBackend::with_config(
        &config.db_file_path,
        SqliteBackendConfig {
            data_dir: Some(spec_dir.clone()),
            ..SqliteBackendConfig::default()
        },
    )
    .with_context(|| {
        format!(
            "failed to open sqlite backend at {}",
            config.db_file_path.display()
        )
    })?;
    sqlite_backend
        .init_schema()
        .context("failed to init sqlite schema")?;
    let loopback_base_url = runtime.loopback_base_url();
    let fhir_server_base_url = {
        let mut url = loopback_base_url.clone();
        url.set_path(FHIR_R4_PATH);
        url
    };

    let server_config = ServerConfig {
        base_url: fhir_server_base_url.to_string(),
        // The host param only expects the ip to bind to
        host: runtime
            .loopback_base_url_ref()
            .host()
            .expect("loopback_base_url must have host")
            .to_string(),
        log_level: config.log_level.clone(),
        max_body_size: MAX_FHIR_BODY_BYTES,
        cors_origins: "*".to_string(),
        cors_headers: "*".to_string(),
        ..ServerConfig::default()
    };

    let (auth_config, auth_state) = build_auth(config.jwks_url.as_deref(), revocation_store);
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
    // /fhir-r4 falls through to HFS.
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
    let patient_everything_route = Router::new()
        .route("/Patient/{id}/$everything", get(patient_everything_handler))
        .with_state(EverythingState {
            hfs_router: hfs_router.clone(),
            loopback_base_url,
        });

    let hfs_router_for_delegation = hfs_router.clone();
    let fhir_with_override = smart_config_route
        .merge(patient_everything_route)
        .fallback_service(hfs_router)
        .layer(DefaultBodyLimit::max(MAX_FHIR_BODY_BYTES));

    // `nest_service`, not `nest`: the FHIR *base* is a real endpoint — a client
    // submits a batch/transaction Bundle as one `POST /`, which mounted here is
    // `POST /fhir-r4/` (with the trailing slash a FHIR base URL carries). `nest`
    // registers only an exact `/fhir-r4` matcher and a `/fhir-r4/{*rest}`
    // catch-all, and matchit's catch-all does not match zero trailing segments,
    // so `/fhir-r4/` matched neither and escaped the nest to the host's SPA
    // fallback (a 200 HTML page for any method). `nest_service` claims the whole
    // `/fhir-r4` subtree — bare root and trailing slash included — for the inner
    // router, so the base reaches HFS. Covered by `tests/batch_bundle_at_base.rs`.
    Ok(FhirR4Routers {
        augmented_fhir_r4_router: Router::new().nest_service(FHIR_R4_PATH, fhir_with_override),
        raw_hfs_router: hfs_router_for_delegation,
    })
}

/// Filename HFS's `SearchParameterLoader` expects for the R4 spec bundle inside
/// `data_dir` — it derives this exact name from the FHIR version and loads no
/// other. The vendored asset (`assets/search-parameters-r4.json`) and the
/// bundled-resource copy the host deploys both use it; must not be renamed.
const SEARCH_PARAMETERS_R4_FILENAME: &str = "search-parameters-r4.json";

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

    /// The vendored asset must ship under the filename HFS's loader expects, be
    /// valid JSON, and cover `Observation.subject` — the parameter
    /// `$everything`'s server-side search depends on. This guards the on-disk
    /// asset (not embedded), which the host deploys as a bundled resource.
    #[test]
    fn vendored_search_parameter_asset_covers_observation_subject() {
        let asset = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join(super::SEARCH_PARAMETERS_R4_FILENAME);
        let json = std::fs::read_to_string(&asset)
            .unwrap_or_else(|e| panic!("read vendored asset {}: {e}", asset.display()));
        let bundle: serde_json::Value =
            serde_json::from_str(&json).expect("vendored SearchParameter bundle is valid JSON");
        assert_eq!(bundle["resourceType"], "Bundle");
        let has_observation_subject = bundle["entry"]
            .as_array()
            .expect("bundle has entry array")
            .iter()
            .filter_map(|entry| entry.get("resource"))
            .any(|resource| {
                resource["resourceType"] == "SearchParameter"
                    && resource["code"] == "subject"
                    && resource["base"]
                        .as_array()
                        .is_some_and(|base| base.iter().any(|b| b == "Observation"))
            });
        assert!(
            has_observation_subject,
            "bundle must define the Observation.subject search parameter"
        );
    }
}

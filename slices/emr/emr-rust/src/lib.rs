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

use std::path::{Path, PathBuf};

use anyhow::Context;
use axum::routing::{get, Router};
use helios_persistence::backends::sqlite::{SqliteBackend, SqliteBackendConfig};
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
    // Materialize the bundled FHIR R4 SearchParameter definitions to disk and
    // point HFS's backend at that directory, so HFS registers every standard R4
    // search parameter and indexes it at write time. Without this, HFS falls
    // back to a ~9-parameter minimal set and `Observation.subject`-style searches
    // return nothing — see [`materialize_search_parameter_specs`] and this
    // crate's `docs/Capability Statement.md`.
    let spec_dir = materialize_search_parameter_specs(&runtime.app_data_dir)
        .context("failed to materialize FHIR SearchParameter definitions")?;
    let sqlite_backend = SqliteBackend::with_config(
        &config.db_file_path,
        SqliteBackendConfig {
            data_dir: Some(spec_dir),
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
    let patient_everything_route = Router::new()
        .route("/Patient/{id}/$everything", get(patient_everything_handler))
        .with_state(EverythingState {
            hfs_router: hfs_router.clone(),
            loopback_base_url,
        });

    let fhir_with_override = smart_config_route
        .merge(patient_everything_route)
        .fallback_service(hfs_router);

    Ok(Router::new().nest(FHIR_R4_PATH, fhir_with_override))
}

/// The complete HL7 FHIR R4 (v4.0.1) `SearchParameter` conformance bundle,
/// embedded at compile time. See `assets/README.md` for provenance/license.
const SEARCH_PARAMETERS_R4_JSON: &str = include_str!("../assets/search-parameters-r4.json");

/// Filename HFS's `SearchParameterLoader` expects for the R4 spec bundle inside
/// `data_dir` — it derives this exact name from the FHIR version and loads no
/// other. Must not be renamed.
const SEARCH_PARAMETERS_R4_FILENAME: &str = "search-parameters-r4.json";

/// Subdirectory of the app-data dir where the embedded SearchParameter bundle is
/// materialized for HFS to read.
const SEARCH_PARAMS_SUBDIR: &str = "fhir-search-params";

/// Write the embedded [`SEARCH_PARAMETERS_R4_JSON`] bundle into a stable
/// subdirectory of `app_data_dir` and return that directory, suitable for
/// [`SqliteBackendConfig::data_dir`].
///
/// HFS loads SearchParameter definitions from a *filesystem* `data_dir` (it has
/// no in-memory registration path), so the compile-time bundle has to be
/// materialized to disk first. We rewrite the file on every startup so the
/// on-disk copy always matches the embedded one (surviving a bundle upgrade or a
/// half-written file from an earlier crash); at ~2&nbsp;MB this is negligible.
///
/// The bundle keeps the [`SEARCH_PARAMETERS_R4_FILENAME`] name HFS derives from
/// the FHIR version, and the subdirectory holds nothing else, so HFS's
/// custom-SearchParameter directory scan finds no stray files to load.
///
/// # Errors
///
/// Returns an error if the subdirectory can't be created or the bundle can't be
/// written.
fn materialize_search_parameter_specs(app_data_dir: &Path) -> anyhow::Result<PathBuf> {
    let spec_dir = app_data_dir.join(SEARCH_PARAMS_SUBDIR);
    std::fs::create_dir_all(&spec_dir).with_context(|| {
        format!(
            "failed to create SearchParameter spec dir at {}",
            spec_dir.display()
        )
    })?;
    let spec_path = spec_dir.join(SEARCH_PARAMETERS_R4_FILENAME);
    std::fs::write(&spec_path, SEARCH_PARAMETERS_R4_JSON).with_context(|| {
        format!(
            "failed to write SearchParameter bundle to {}",
            spec_path.display()
        )
    })?;
    Ok(spec_dir)
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

    /// The embedded bundle must be the real, parseable HL7 R4 SearchParameter
    /// set: a `Bundle` whose entries include `Observation.subject` (the param
    /// `$everything`'s server-side compartment search depends on).
    #[test]
    fn embedded_search_parameter_bundle_covers_observation_subject() {
        let bundle: serde_json::Value = serde_json::from_str(super::SEARCH_PARAMETERS_R4_JSON)
            .expect("embedded SearchParameter bundle is valid JSON");
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

    /// [`materialize_search_parameter_specs`] writes the bundle under the
    /// expected filename so HFS's loader finds it, and is idempotent across
    /// repeated startups.
    #[test]
    fn materialize_writes_the_spec_bundle_under_the_expected_name() {
        let tmp = std::env::temp_dir().join(format!(
            "emr-rust-materialize-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);

        let spec_dir = super::materialize_search_parameter_specs(&tmp).expect("materialize");
        let spec_file = spec_dir.join(super::SEARCH_PARAMETERS_R4_FILENAME);
        assert!(spec_file.is_file(), "spec bundle written to {spec_file:?}");
        assert_eq!(
            std::fs::read_to_string(&spec_file).expect("read back"),
            super::SEARCH_PARAMETERS_R4_JSON,
        );

        // Idempotent: a second call over the same dir succeeds and leaves the
        // same content (mirrors a restart).
        super::materialize_search_parameter_specs(&tmp).expect("materialize again");
        assert_eq!(
            std::fs::read_to_string(&spec_file).expect("read back after re-run"),
            super::SEARCH_PARAMETERS_R4_JSON,
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

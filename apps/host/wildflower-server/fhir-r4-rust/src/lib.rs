//! fhir-r4-rust is a thin embedding of [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs)
//! as the FHIR R4 backend. It opens a sqlite store, serves HFS's Axum router
//! at the server's root (FHIR base = origin), overrides the SMART discovery doc with a
//! SMART-App-Launch-shaped one, adds the `$everything` operation HFS lacks, and
//! (optionally) wires HFS's bearer-JWT auth + SMART v2 scope policy against
//! gatekeeper's JWKS.

mod auth;
mod config;
mod delegate;
mod patient_everything;
mod smart_configuration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use axum::http::Method;
use axum::routing::{get, Router};
use helios_persistence::backends::sqlite::{SqliteBackend, SqliteBackendConfig};
use helios_rest::fhir_types::is_valid_resource_type;
use helios_rest::{create_app_with_auth, ServerConfig};
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;

use wildflowerhealthio_token_revocation::RevocationStore;

use crate::auth::build_auth;
use crate::patient_everything::{patient_everything_handler, EverythingState};
use crate::smart_configuration::{smart_configuration_handler, SmartConfigState};

pub use crate::config::FhirR4Config;

const MAX_FHIR_BODY_BYTES: usize = 1024 * 1024 * 1024; // 1 GiB

/// Result of [`setup_fhir_r4`]: the augmented FHIR R4 router, and the bare HFS
/// router for in-process delegation by other slices. Both answer at the root;
/// the host hands a request to them only when [`is_fhir_r4_route`] says it is
/// FHIR's.
pub struct FhirR4Routers {
    pub augmented_fhir_r4_router: Router,
    pub raw_hfs_router: Router,
}

/// Paths a gating layer mounted above [`setup_fhir_r4`]'s router must let
/// through without a bearer token: the FHIR capabilities statement and the
/// discovery docs a client fetches *before* it holds a token. Mirrors HFS's own
/// `EXEMPT_PATHS` (helios-rest's `middleware/auth.rs`) — HFS already exempts
/// these from its own auth, but the host's bearer gate above us must be told.
/// HFS's `/health` is left out: the host serves its own `/health` at the root,
/// so HFS's is never reached.
pub const UNAUTHENTICATED_FHIR_PATHS: &[&str] = &[
    "/metadata",
    "/.well-known/smart-configuration",
    "/$versions",
    "/_liveness",
    "/_readiness",
];

/// First path segments HFS serves that are neither a resource type nor a
/// `$operation`: the server-level interactions, the discovery docs (under
/// `.well-known`), and the bulk-data, admin and console surfaces.
const FHIR_ROOT_SEGMENTS: &[&str] = &[
    "metadata",
    "_history",
    "_search",
    "_liveness",
    "_readiness",
    "export",
    "export-file",
    "export-status",
    "bulk-submit-file",
    "bulk-submit-status",
    "admin",
    "console",
    "ws",
];

/// The `.well-known` documents HFS serves.
const FHIR_WELL_KNOWN_DOCUMENTS: &[&str] = &["smart-configuration", "bulk-submit-jwks.json"];

/// Whether a request belongs to the FHIR API, which shares the server's root
/// with the other slices. The host routes a request to [`setup_fhir_r4`]'s
/// router only when this holds, so a path no slice claims still gets the
/// host's own `404` rather than a FHIR one.
///
/// FHIR's are: `POST /` (a batch or transaction Bundle at the base — a `GET /`
/// is someone opening the server, not a FHIR call), a path under an R4 resource
/// type (case-sensitive, so `Device` is FHIR's and `devices` is not), a
/// system-level `$operation`, one of [`FHIR_ROOT_SEGMENTS`], and the
/// [`FHIR_WELL_KNOWN_DOCUMENTS`].
#[must_use]
pub fn is_fhir_r4_route(method: &Method, path: &str) -> bool {
    let mut segments = path.trim_start_matches('/').split('/');
    let first = segments.next().unwrap_or_default();
    match first {
        "" => method == Method::POST,
        ".well-known" => segments
            .next()
            .is_some_and(|document| FHIR_WELL_KNOWN_DOCUMENTS.contains(&document)),
        _ => {
            first.starts_with('$')
                || FHIR_ROOT_SEGMENTS.contains(&first)
                || is_valid_resource_type(first)
        }
    }
}

/// Build the FHIR R4 [`Router`], opening the sqlite backend and initializing
/// its schema.
///
/// The router serves HFS at the root with two overrides mounted ahead of it:
/// - `/.well-known/smart-configuration` is handled locally so we can
///   advertise the SMART App Launch grant + gatekeeper's authorize/token URLs,
///   which HFS's built-in (Backend-Services-shaped) discovery doc doesn't.
/// - `/Patient/{id}/$everything` implements the FHIR `$everything`
///   operation HFS doesn't ship, by delegating back into HFS's `read` + indexed
///   `subject=` searches in-process (see [`patient_everything`]).
///
/// When [`FhirR4Config::jwks_url`] is `Some`, HFS auth is enabled: it validates the
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
/// HFS's `base_url`, the prefix of every URL it emits (Bundle links,
/// `fullUrl`s, `Location`), is [`FhirR4Config::public_origin`]'s FHIR base: HFS
/// never reads `Forwarded`/`Host` to vary it, so a client that pages by
/// following `next` lands on the public origin.
///
/// # Errors
///
/// Returns an error if the configured SearchParameter asset directory does not
/// contain the R4 spec bundle, if the sqlite backend cannot be opened at the
/// configured path, or if initializing its schema fails.
pub fn setup_fhir_r4(
    runtime: &ServerRuntimeConfig,
    config: &FhirR4Config,
    revocation_store: RevocationStore,
) -> anyhow::Result<FhirR4Routers> {
    // Point HFS's backend at the on-disk FHIR R4 SearchParameter asset directory
    // the host provides (a bundled resource — never embedded in the binary), so
    // HFS registers every standard R4 search parameter and indexes it at write
    // time. Without a real spec dir HFS falls back to a ~9-parameter minimal set
    // and `Observation.subject`-style searches return nothing, so we fail fast if
    // the bundle isn't there rather than silently degrade — see
    // [`FhirR4Config::search_parameter_data_dir`] and this crate's
    // `docs/Capability Statement.md`.
    let spec_dir = &config.search_parameter_data_dir;
    let spec_file = spec_dir.join(SEARCH_PARAMETERS_R4_FILENAME);
    if !spec_file.is_file() {
        anyhow::bail!(
            "FHIR R4 SearchParameter bundle not found at {} — the `{}` asset must be \
             deployed and `FhirR4Config::search_parameter_data_dir` must point at its directory",
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

    let server_origin = wildflowerhealthio_shared_structures::origin_string(&config.public_origin);
    let server_config = ServerConfig {
        base_url: server_origin.clone(),
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

    let (auth_config, auth_state) =
        build_auth(config.jwks_url.as_deref(), revocation_store, &server_origin);
    let hfs_router = create_app_with_auth(
        sqlite_backend,
        server_config,
        auth_config,
        auth_state,
        // Audit middleware: we don't write FHIR audit events from inside
        // fhir-r4-rust today; the gatekeeper gating layer above us handles
        // owner/admin access auditing separately.
        None,
    );

    // Specific routes win over fallback: our SMART App Launch discovery doc and
    // the `$everything` operation intercept their paths; every other FHIR path
    // falls through to HFS.
    let smart_config_route = Router::new()
        .route(
            "/.well-known/smart-configuration",
            get(smart_configuration_handler),
        )
        .with_state(SmartConfigState {
            loopback_base_url: loopback_base_url.clone(),
            server_origin,
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

    Ok(FhirR4Routers {
        augmented_fhir_r4_router: fhir_with_override,
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
    use super::{is_fhir_r4_route, UNAUTHENTICATED_FHIR_PATHS};
    use axum::http::Method;

    /// The gate exempts these only on the FHIR router, so each must route there.
    #[test]
    fn unauthenticated_paths_are_fhir_routes() {
        for path in UNAUTHENTICATED_FHIR_PATHS {
            assert!(
                is_fhir_r4_route(&Method::GET, path),
                "{path} must route to FHIR"
            );
        }
    }

    #[test]
    fn unauthenticated_paths_cover_smart_discovery() {
        assert!(UNAUTHENTICATED_FHIR_PATHS.contains(&"/metadata"));
        assert!(UNAUTHENTICATED_FHIR_PATHS.contains(&"/.well-known/smart-configuration"));
    }

    #[test]
    fn fhir_routes_are_resource_types_operations_and_hfs_surfaces() {
        let fhir = [
            (Method::POST, "/"),
            (Method::GET, "/Patient"),
            (Method::GET, "/Patient/p1"),
            (Method::GET, "/Patient/p1/$everything"),
            (Method::PUT, "/MedicationRequest/mr1"),
            (Method::GET, "/Device/d1"),
            (Method::GET, "/$export"),
            (Method::GET, "/metadata"),
            (Method::GET, "/_history"),
            (Method::GET, "/export-status/job-1"),
            (Method::GET, "/admin/tenants"),
            (Method::GET, "/console/metrics/uptime"),
            (Method::GET, "/.well-known/smart-configuration"),
            (Method::GET, "/.well-known/bulk-submit-jwks.json"),
        ];
        for (method, path) in fhir {
            assert!(is_fhir_r4_route(&method, path), "{method} {path} is FHIR's");
        }
    }

    /// The other slices' routes, a browser opening the server, and paths no one
    /// serves are not FHIR's — they keep the host's routing and its `404`.
    #[test]
    fn host_routes_and_unknown_paths_are_not_fhir_routes() {
        let not_fhir = [
            (Method::GET, "/"),
            (Method::GET, "/home"),
            (Method::GET, "/health"),
            (Method::GET, "/devices/ABCD"),
            (Method::GET, "/patient/p1"),
            (Method::POST, "/oauth/token"),
            (Method::GET, "/.well-known/jwks.json"),
            (Method::GET, "/apps"),
            (Method::GET, "/fhir-r4/Patient"),
            (Method::GET, "/NotAResourceType/x"),
        ];
        for (method, path) in not_fhir {
            assert!(
                !is_fhir_r4_route(&method, path),
                "{method} {path} is not FHIR's"
            );
        }
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

//! fhir-r4-rust is a thin embedding of [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs)
//! as the FHIR R4 backend. It opens a sqlite store, serves HFS's Axum router
//! at the server's root (FHIR base = origin), overrides the SMART discovery doc with a
//! SMART-App-Launch-shaped one, adds the `$everything` operation HFS lacks,
//! mounts HFS's web UI at `/ui` with its sign-in against the authorization server, and
//! (optionally) wires HFS's bearer-JWT auth + SMART v2 scope policy through
//! the host's access-token verifier, run in process.

mod auth;
mod bulk_export;
mod config;
mod delegate;
mod patient_everything;
mod smart_configuration;

use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::Method;
use axum::response::IntoResponse;
use axum::routing::{get, Route, Router};
use helios_auth::{LoginConfig, SessionStore};
use helios_persistence::backends::local_fs::LocalFsOutputStore;
use helios_persistence::backends::sqlite::{SqliteBackend, SqliteBackendConfig};
use helios_persistence::core::SettingsStore;
use helios_rest::fhir_types::is_valid_resource_type;
use helios_rest::{create_app_with_auth_bulk_and_settings, ServerConfig};
use tower::{Layer, Service};
use wildflowerhealthio_scopes::{Permission, Scope};

use crate::auth::build_auth;
use crate::bulk_export::bulk_export_bundle;
use crate::patient_everything::{patient_everything_handler, EverythingState};
use crate::smart_configuration::{smart_configuration_handler, SmartConfigState};

pub use crate::auth::{AccessTokenVerifier, AccessTokenVerifyError, VerifiedAccessToken};
pub use crate::bulk_export::BulkExportWorker;
pub use crate::config::FhirR4Config;

const MAX_FHIR_BODY_BYTES: usize = 1024 * 1024 * 1024; // 1 GiB

/// Result of [`setup_fhir_r4`]: the augmented FHIR R4 router (the FHIR API
/// behind the host's gate, under the web UI), the bare HFS router for
/// in-process delegation by other slices, and the worker that runs the jobs
/// `$export` accepts. Both routers answer at the root; the host hands a request
/// to them only when [`is_fhir_r4_route`] says it is FHIR's.
pub struct FhirR4Routers {
    pub augmented_fhir_r4_router: Router,
    pub raw_hfs_router: Router,
    pub bulk_export_worker: BulkExportWorker,
}

/// Paths the gate passed to [`setup_fhir_r4`] must let through without a
/// bearer token: the FHIR capabilities statement and the
/// discovery docs a client fetches *before* it holds a token. Mirrors HFS's own
/// `EXEMPT_PATHS` (helios-rest's `middleware/auth.rs`) — HFS already exempts
/// these from its own auth, but the host's bearer gate must be told.
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
/// `$operation`: the web UI and its per-user settings, the server-level
/// interactions, and the bulk-data, admin, console and subscription surfaces.
const FHIR_ROOT_SEGMENTS: &[&str] = &[
    "ui",
    "_user",
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
/// with the other slices: the host routes a request to [`setup_fhir_r4`]'s
/// router only when this holds. Which paths are FHIR's, and why, is "Served at
/// the root, on FHIR paths only" in `docs/Capability Statement.md`.
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
///   advertise the SMART App Launch grant + the authorization server's authorize/token URLs,
///   which HFS's built-in (Backend-Services-shaped) discovery doc doesn't.
/// - `/Patient/{id}/$everything` implements the FHIR `$everything`
///   operation HFS doesn't ship, by delegating back into HFS's `read` + indexed
///   `subject=` searches in-process (see [`patient_everything`]).
///
/// When `access_token_verifier` is `Some`, HFS auth is enabled: each bearer
/// is verified through it, in process (signature, expiry, `iss` and `aud`,
/// revocation), its SMART v2 scopes are parsed, and each FHIR operation is
/// gated against them.
/// `None` leaves HFS open, relying on whatever wraps this router from outside
/// (e.g. the host's bearer gate). The discovery override and
/// HFS's `/metadata` remain unauthenticated per the SMART spec — see
/// [`UNAUTHENTICATED_FHIR_PATHS`].
///
/// `fhir_api_gate` is the host's bearer gate, layered over the FHIR API (HFS
/// and both overrides) and not over the web UI: HFS sends a visitor without a
/// session to its sign-in, which a bearer gate would refuse outright. The UI
/// is mounted over the gated API, so its pages pass by route while anything
/// else, an unknown `/ui/…` path included, falls through to the gate.
///
/// `ui_sessions` holds the web UI's signed-in sessions (built from
/// [`ui_login_config`] by the host, which shares it with the middleware in
/// front of this router): the UI's login runs against it, and HFS takes a
/// same-site request carrying its `hfs_session` cookie and no `Authorization`
/// as the session's bearer.
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
pub fn setup_fhir_r4<Gate>(
    config: &FhirR4Config,
    access_token_verifier: Option<Arc<dyn AccessTokenVerifier>>,
    ui_sessions: Arc<SessionStore>,
    fhir_api_gate: Gate,
) -> anyhow::Result<FhirR4Routers>
where
    Gate: Layer<Route> + Clone + Send + Sync + 'static,
    Gate::Service: Service<Request> + Clone + Send + Sync + 'static,
    <Gate::Service as Service<Request>>::Response: IntoResponse + 'static,
    <Gate::Service as Service<Request>>::Error: Into<Infallible> + 'static,
    <Gate::Service as Service<Request>>::Future: Send + 'static,
{
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
    let server_origin = wildflowerhealthio_shared_structures::origin_string(&config.public_origin);
    let server_config = ServerConfig {
        base_url: server_origin.clone(),
        log_level: config.log_level.clone(),
        max_body_size: MAX_FHIR_BODY_BYTES,
        cors_origins: "*".to_string(),
        cors_headers: "*".to_string(),
        ..ServerConfig::default()
    };

    let bulk_export_config = server_config.bulk_export.clone();
    let hfs_auth_enabled = access_token_verifier.is_some();
    let (auth_config, auth_state) =
        build_auth(access_token_verifier, &server_origin, ui_sessions.clone());
    // The web UI's per-user settings (`/_user/settings`), which also track its
    // bulk-export jobs, live in the health data's own sqlite file, in HFS's
    // `user_settings` table; so do the export jobs themselves.
    let sqlite_backend = Arc::new(sqlite_backend);
    let ui_settings_store: Arc<dyn SettingsStore> = sqlite_backend.clone();
    // Export files are only ever downloaded through HFS's `/export-file`, which
    // asks for a bearer exactly when HFS auth is on.
    let export_output_store = Arc::new(
        LocalFsOutputStore::new(&config.bulk_export_dir, server_origin.clone())
            .with_access_token_required(hfs_auth_enabled),
    );
    let bulk_export_worker = BulkExportWorker::new(
        sqlite_backend.clone(),
        export_output_store.clone(),
        bulk_export_config,
    );
    let hfs_router = create_app_with_auth_bulk_and_settings(
        sqlite_backend.clone(),
        server_config,
        auth_config.clone(),
        auth_state,
        // Audit middleware: we don't write FHIR audit events from inside
        // fhir-r4-rust today; the authorization server gating layer above us handles
        // owner/admin access auditing separately.
        None,
        Some(bulk_export_bundle(sqlite_backend, export_output_store)),
        // Bulk submit is not wired.
        None,
        Some(ui_settings_store.clone()),
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
            server_origin: server_origin.clone(),
            authorization_app_base: config.authorization_app_base.clone(),
        });

    // `$everything` delegates back into HFS in-process (see
    // [`patient_everything`]), so it holds a clone of `hfs_router`; the original
    // stays the fallback for every other FHIR path.
    let patient_everything_route = Router::new()
        .route("/Patient/{id}/$everything", get(patient_everything_handler))
        .with_state(EverythingState {
            hfs_router: hfs_router.clone(),
            public_origin: config.public_origin.clone(),
        });

    let hfs_router_for_delegation = hfs_router.clone();
    let fhir_api = smart_config_route
        .merge(patient_everything_route)
        .fallback_service(hfs_router)
        .layer(DefaultBodyLimit::max(MAX_FHIR_BODY_BYTES))
        .layer(fhir_api_gate);

    // The UI's routes sit beside the gated API, not inside it; everything they
    // don't claim falls through to the gate.
    let fhir_api_with_ui = mount_ui(
        fhir_api,
        spec_dir,
        &server_origin,
        auth_config.outbound_provider(),
        ui_sessions,
        ui_settings_store,
    );

    Ok(FhirR4Routers {
        augmented_fhir_r4_router: fhir_api_with_ui,
        raw_hfs_router: hfs_router_for_delegation,
        bulk_export_worker,
    })
}

/// Serializes [`mount_ui`] across the process. `helios-ui`'s login and
/// dashboard settings are process-wide statics that each mount reads once, so
/// two servers setting up in one process at once could otherwise each mount the
/// other's session store.
static UI_MOUNT: Mutex<()> = Mutex::new(());

/// Mount HFS's web UI (`helios-ui`) at `/ui` over `fhir_api`, which serves
/// every request the UI's routes don't claim, with its interactive login over
/// `ui_sessions` and its per-user settings in `ui_settings_store`. Without a
/// settings store the UI turns its bulk export and import pages off.
///
/// The UI's conformance pages call the server's own FHIR API over HTTP, at
/// `server_origin`, the only address the server is served at, carrying the
/// signed-in user's bearer or none.
fn mount_ui(
    fhir_api: Router,
    spec_dir: &std::path::Path,
    server_origin: &str,
    outbound_auth: Arc<dyn helios_auth::outbound::OutboundAuthProvider>,
    ui_sessions: Arc<SessionStore>,
    ui_settings_store: Arc<dyn SettingsStore>,
) -> Router {
    let _serialized = UI_MOUNT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    helios_ui::set_interactive_login(helios_ui::LoginRuntime {
        sessions: ui_sessions,
    });
    // The Home dashboard never refreshes itself (#1078).
    helios_ui::set_dashboard_refresh(helios_ui::DashboardRefresh {
        moving_secs: u32::MAX,
        settled_secs: u32::MAX,
    });
    helios_ui::mount_with_body_limit_and_tenant_routing(
        fhir_api,
        env!("CARGO_PKG_VERSION"),
        Some(spec_dir.to_path_buf()),
        helios_ui::NlSearch {
            enabled: false,
            configured: false,
            model: String::new(),
        },
        None,
        Some(ui_settings_store),
        String::new(),
        server_origin.to_string(),
        outbound_auth,
        helios_fhir::FhirVersion::R4,
        None,
        server_origin.to_string(),
        MAX_UI_BODY_BYTES,
        false,
        None,
        helios_ui::PatientNameSearchSupport::Enabled,
        None,
    )
}

/// The largest request body the UI's own pages accept (its imports and editor).
const MAX_UI_BODY_BYTES: usize = 30 * 1024 * 1024;

/// The web UI's sign-in, as `helios-auth`'s [`LoginConfig`]: the
/// authorization-code flow with PKCE against this server's authorization server, as the
/// public client `ui_client_id` (which the authorization server seeds with
/// `{public_origin}/ui/callback` as its redirect URI), asking for
/// `user/*.cruds`.
///
/// The browser is sent to the authorize endpoint on `public_origin`, where it
/// reaches the server, and HFS redeems the code server-side at the token
/// endpoint there too, out through the relay and back down the tunnel: the
/// server listens nowhere else. The authorization server has no OpenID
/// Connect, so there is no ID token and no end-session endpoint: the session's
/// identity is its access token's `sub`.
#[must_use]
pub fn ui_login_config(public_origin: &url::Url, ui_client_id: &str) -> LoginConfig {
    let origin = wildflowerhealthio_shared_structures::origin_string(public_origin);
    LoginConfig {
        client_id: ui_client_id.to_string(),
        client_secret: None,
        redirect_uri: format!("{origin}/ui/callback"),
        scopes: Scope::fhir_user_all(Permission::ALL).to_string(),
        authorization_endpoint: format!("{origin}/oauth/authorize"),
        token_endpoint: format!("{origin}/oauth/token"),
        end_session_endpoint: None,
        cookie_secure: public_origin.scheme() == "https",
    }
}

/// Filename HFS's `SearchParameterLoader` expects for the R4 spec bundle inside
/// `data_dir` — it derives this exact name from the FHIR version and loads no
/// other. The vendored asset (`assets/search-parameters-r4.json`) and the
/// bundled-resource copy the host deploys both use it; must not be renamed.
const SEARCH_PARAMETERS_R4_FILENAME: &str = "search-parameters-r4.json";

#[cfg(test)]
mod tests {
    use super::{is_fhir_r4_route, ui_login_config, UNAUTHENTICATED_FHIR_PATHS};
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
            (Method::GET, "/ui"),
            (Method::GET, "/ui/resources"),
            (Method::GET, "/ui/callback"),
            (Method::PUT, "/_user/settings"),
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

    /// The UI signs in through the browser at the public origin, redeems the
    /// code there too, comes back to the redirect URI the authorization server
    /// seeds, and asks for `user/*.cruds` as a public client; its cookie is
    /// `Secure` on an https origin.
    #[test]
    fn ui_login_config_points_the_browser_and_the_redemption_at_the_public_origin() {
        let public_origin = url::Url::parse("https://ruth.relay.example").expect("origin");

        let login = ui_login_config(&public_origin, "fhir-ui-client");

        assert_eq!(
            (
                login.client_id.as_str(),
                login.client_secret,
                login.redirect_uri.as_str(),
                login.scopes.as_str(),
                login.authorization_endpoint.as_str(),
                login.token_endpoint.as_str(),
                login.end_session_endpoint,
                login.cookie_secure,
            ),
            (
                "fhir-ui-client",
                None,
                "https://ruth.relay.example/ui/callback",
                "user/*.cruds",
                "https://ruth.relay.example/oauth/authorize",
                "https://ruth.relay.example/oauth/token",
                None,
                true,
            )
        );
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

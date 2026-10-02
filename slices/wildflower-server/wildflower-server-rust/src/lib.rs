//! The Wildflower server: the loopback API every slice mounts on, composed and
//! served by [`serve`].
//!
//! [`serve`] opens the host's databases, sets up each server slice (gatekeeper,
//! FHIR R4, OHIF, collector, tunnel, apps, databases), gates them, wraps them in
//! the loopback owner trust, the loopback-peer gate and the CORS policy, and
//! serves the result on the loopback port until its shutdown token is cancelled.
//!
//! The crate has no `tauri` dependency. What the host derives at build time or
//! from its platform paths arrives in [`WildflowerServerConfig`]; the host's
//! native adapters and the channels its bridge reads arrive in [`HostPorts`].

mod hfs_base_url;
mod loopback_owner_trust;
mod not_found;
mod tunnel_adapters;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use apps_rust::{ports::AppLaunchScopes, setup_apps, AppsConfig};
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{
    client_allowed_scopes, gatekeeper_auth_middleware, require_loopback_peer_middleware,
    setup_gatekeeper, GatekeeperConfig, LoopbackConsentPrompt, PendingConsentHead,
};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

use loopback_owner_trust::{inject_loopback_owner_token, LoopbackOwnerTrust};

// Filenames of the host's SQLite databases under the shared app-data dir. These
// are the single source of truth for each database's on-disk name: the slice
// that opens it AND the data-management catalogue (`/databases`) reference the
// same const, so adding or renaming a database is one edit here. The server owns
// these names — `databases-rust` has no built-in knowledge of them.
const HEALTH_DATA_DB: &str = "health-data.sqlite";
const WILDFLOWER_DB: &str = "wildflower.sqlite";

/// What the host hands [`serve`]: the values it derives at build time
/// (`tauri-shared-config.json`, build-time env) or from its platform paths.
#[derive(Debug, Clone)]
pub struct WildflowerServerConfig {
    /// The loopback base URL the API binds and the app-data dir the databases and
    /// served files live under.
    pub runtime: ServerRuntimeConfig,
    /// The directory holding the FHIR R4 SearchParameter bundle HFS indexes from
    /// (see [`EmrConfig::search_parameter_data_dir`]).
    pub search_parameter_data_dir: PathBuf,
    /// The hosted owner UI every browser-facing link points at.
    pub owner_ui_base: OwnerUiBase,
    /// The scopes gatekeeper seeds the first-party client with and mints the host
    /// owner token under (see [`GatekeeperConfig::host_owner_scopes`]).
    pub host_owner_scopes: Vec<String>,
    /// The host's first-party OAuth `client_id`.
    pub first_party_client_id: String,
    /// Tunnel connection defaults seeded into unconfigured settings at startup.
    pub tunnel_seed: tunnel_rust::SettingsSeed,
}

/// The host's side of [`serve`]: its native adapters and the channels the
/// server publishes host→webview state on.
///
/// The senders are owned by the host, so their receivers (the host's bridge)
/// outlive any one [`serve`]; cloning the ports for another run keeps the same
/// channels.
#[derive(Clone)]
pub struct HostPorts {
    /// The native Approve / Reject dialog gatekeeper raises when the hosted owner
    /// UI logs in over direct loopback.
    pub loopback_consent_prompt: Arc<dyn LoopbackConsentPrompt>,
    /// Opens a loopback app launch in an on-device native webview popup.
    pub on_device_webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    /// The channel gatekeeper publishes each minted host owner token on. The
    /// loopback owner trust reads it, so a receiver must be alive when [`serve`]
    /// mints the first token.
    pub host_owner_token_sender: watch::Sender<Option<String>>,
    /// The channel gatekeeper publishes the active pending consent request on.
    pub active_pending_consent_sender: watch::Sender<Option<PendingConsentHead>>,
}

/// The host's [`apps_rust::ports::AppLaunchScopes`]: resolves a **SMART** app's
/// `client_id` to its OAuth client's allowed scopes (via
/// [`gatekeeper_rust::client_allowed_scopes`], which reads inside the opaque
/// `GatekeeperState`), so the apps launch handler can require the launching
/// caller's grant to cover them. A non-SMART app (no `client_id`) needs no per-app
/// scopes — only the `wildflower/launch` umbrella.
#[derive(Clone)]
struct GatekeeperAppLaunchScopes {
    state: std::sync::Arc<gatekeeper_rust::GatekeeperState>,
}

impl AppLaunchScopes for GatekeeperAppLaunchScopes {
    fn required_scopes(
        &self,
        registration: &apps_rust::AppRegistration,
    ) -> Result<Vec<scopes_rust::Scope>, apps_rust::domain::AppsError> {
        // The capability only calls this for a SMART app, but stay defensive.
        let Some(client_id) = registration.client_id.as_deref() else {
            return Ok(Vec::new());
        };
        client_allowed_scopes(&self.state, client_id).map_err(|error| {
            apps_rust::domain::AppsError::infrastructure("resolve SMART app launch scopes", error)
        })
    }
}

/// The API surface's CORS policy: mirror any origin, method and request headers
/// (every endpoint is loopback-gated and bearer-authenticated, so CORS is not the
/// access control), **never** allow credentials, and answer Chrome's Local
/// Network Access preflight.
///
/// Mirroring headers rather than `*` matters: the CORS spec's header wildcard
/// excludes `Authorization`, the one header the bearer clients need. Credentials
/// stay off because the server authenticates by `Authorization: Bearer` alone —
/// no ambient credential (cookie, HTTP auth) exists for a cross-origin page to
/// ride. A page on a public origin — the hosted owner UI at
/// `wildflowerhealth.io/app/` — fetching this loopback server makes Chrome send
/// `Access-Control-Request-Private-Network: true`, and it blocks the request
/// unless the preflight answers `Access-Control-Allow-Private-Network: true`.
fn api_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        .allow_private_network(true)
}

/// Set up every server slice over the host's databases and serve the API on the
/// loopback port until `shutdown` is cancelled.
///
/// `config` is what the host derived at build time or from its paths; `host`
/// carries its native adapters and its bridge's channels. Cancelling `shutdown`
/// stops accepting connections, and the call returns `Ok` once the open ones
/// close.
///
/// # Errors
///
/// Returns an error if startup fails (a scheduled database deletion can't be
/// applied, a database or store can't be opened, the loopback port can't be
/// bound, a slice's setup fails, or the tunnel's stored public host can't be
/// FHIR's base URL), or if serving fails.
///
/// # Remarks
///
/// Slices spawn background tasks (the tunnel supervisor, gatekeeper's re-mint
/// and sweeps, the FHIR base-URL follower) onto the runtime that runs this
/// future; they are not tied to `shutdown`.
pub async fn serve(
    config: WildflowerServerConfig,
    host: HostPorts,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let WildflowerServerConfig {
        runtime,
        search_parameter_data_dir,
        owner_ui_base,
        host_owner_scopes,
        first_party_client_id,
        tunnel_seed,
    } = config;

    // Apply any deletions the Owner scheduled from the data-management screen
    // BEFORE opening the databases below: the `/databases` DELETE can't remove a
    // file the owning slice holds open, so it drops a marker that we purge here,
    // while nothing has the file open yet.
    databases_rust::purge_pending_deletions(&runtime.app_data_dir)
        .context("failed to purge scheduled database deletions")?;

    let loopback_host = runtime.loopback_base_url_ref().authority().to_string();
    // The typed loopback base URL is the single source threaded into every
    // slice's config (apps / gatekeeper / emr / tunnel). `loopback_origin` is its
    // bare origin string (no trailing slash) for the few sub-URLs built by hand.
    let loopback_base_url = runtime.loopback_base_url();
    let loopback_origin = shared_structures_rust::origin_string(&loopback_base_url);
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join(HEALTH_DATA_DB),
        // HFS-enforced auth: every FHIR request must carry a Bearer JWT
        // signed by a gatekeeper-issued key. `iss` is pinned to
        // [`shared_structures_rust::CANONICAL_ISSUER`] by both gatekeeper
        // (at mint) and emr-rust (at validation).
        jwks_url: Some(format!("{loopback_origin}/.well-known/jwks.json")),
        search_parameter_data_dir,
    };
    let gatekeeper_config = GatekeeperConfig {
        loopback_base_url: loopback_base_url.clone(),
        host_owner_scopes,
        first_party_client_id,
        owner_ui_base: owner_ui_base.clone(),
    };

    // One shared SQLite database for all persistence-rust-backed slices
    // (gatekeeper, and the tunnel slice); each runs its own namespaced
    // migrations on it. (The FHIR/emr store is managed separately by
    // helios-persistence.)
    let db_path = runtime.app_data_dir.join(WILDFLOWER_DB);
    let db =
        persistence_rust::Connection::open(&db_path).context("failed to open shared database")?;

    // One shared token-revocation store on that same connection, built BEFORE
    // both setups and threaded into each: gatekeeper's auth gate runs the full
    // revocation check (denylist + subject epoch) through it, and HFS reads the
    // per-jti denylist through it (defense-in-depth behind the gate). One store,
    // two enforcement points. See #269.
    let revocation_store = token_revocation_rust::RevocationStore::new(db.clone())
        .context("failed to open token-revocation store")?;

    // Bind BEFORE minting/publishing the Owner token: `setup_gatekeeper`
    // pushes the freshly-minted token onto the owner-token channel the
    // loopback owner trust presents (and the bridge emits a contentless
    // `AuthTokenIssued` notify to flip the page's auth-readiness signal).
    // If the port were already taken, minting first would mean minting a
    // full-Owner bearer while a *foreign* process owns `127.0.0.1:<port>`.
    // Binding first guarantees the token is only ever minted once this
    // process owns the port.
    let listener = TcpListener::bind(&loopback_host)
        .await
        .with_context(|| format!("failed to bind to {loopback_host}"))?;

    let fhir_routers = setup_fhir_r4(&runtime, &emr_config, revocation_store.clone())
        .context("failed to set up FHIR R4 router")?;
    let fhir_r4_router = fhir_routers.augmented_fhir_r4_router;

    // The app-wide diesel r2d2 pool, built once here on the same database file
    // `db` serves the other slices from and shared (cheap `Arc` clone) across
    // every diesel-backed slice — the gatekeeper OAuth surface, the collector
    // `/collector/remotes` surface, and the tunnel `/tunnel` surface all run
    // over it rather than each opening their own. Its connections are NOT
    // synchronized with the `Arc<Mutex<rusqlite::Connection>>` the other slices
    // write through: an accepted single-writer file-lock contention trade-off,
    // ridden out by a shared `busy_timeout`. This is where that trade-off is
    // accepted — see docs/Persistence/Shared Diesel Pool Explanation.md.
    //
    // Built BEFORE `setup_gatekeeper` because the gatekeeper store now rides
    // this pool too (its diesel migrations run when the store is constructed).
    let diesel_pool =
        persistence_rust::open_pool(&db_path).context("failed to open diesel db pool")?;

    // DEBUG BUILDS ONLY: the `…-dev` app rows pointing at the first-party apps'
    // vite dev servers, plus their matching OAuth clients. The first-party apps
    // ship as rows served from https://wildflowerhealth.io, which is the
    // wrong target while developing them — these siblings launch
    // `http://localhost:<vite port>/` instead. They are a runtime seed rather than
    // a migration precisely so they cannot exist in a release database (a
    // migration runs unconditionally); both the seeds and this call site are
    // `cfg(debug_assertions)`, so release builds contain no code that writes them.
    // Best-effort: a failure only costs the dev tiles, never startup.
    #[cfg(debug_assertions)]
    {
        if let Err(error) = apps_rust::seed_dev_apps(diesel_pool.clone()) {
            tracing::warn!("failed to seed dev app rows: {error:#}");
        }
        if let Err(error) = gatekeeper_rust::seed_dev_app_clients(diesel_pool.clone()) {
            tracing::warn!("failed to seed dev app OAuth clients: {error:#}");
        }
    }

    // `setup_gatekeeper` publishes the freshly-minted host owner token (and
    // pending-consent heads) on the host's channels; the host's bridge delivers
    // them to the webview.
    let gatekeeper = setup_gatekeeper(
        diesel_pool.clone(),
        revocation_store,
        &gatekeeper_config,
        &host.host_owner_token_sender,
        host.active_pending_consent_sender,
        host.loopback_consent_prompt,
    )
    .context("failed to set up gatekeeper")?;

    // The FHIR router carries discovery docs (metadata, SMART well-known) that a
    // client fetches before it holds a token, so those paths are exempted from
    // the bearer gate; every other `/fhir-r4/*` path still requires a token.
    let gated_fhir_r4 = fhir_r4_router.layer(gatekeeper_auth_middleware(
        gatekeeper.state.clone(),
        emr_rust::UNAUTHENTICATED_FHIR_PATHS,
    ));

    let gatekeeper_auth_layer = gatekeeper_auth_middleware(gatekeeper.state.clone(), &[]);

    let gated_ohif_server = ohif_server_rust::setup_ohif_server(fhir_routers.raw_hfs_router)
        .layer(gatekeeper_auth_layer.clone());

    // The real `/collector/remotes` surface (replacing the former api_stubs
    // stub — the demo FHIR remote it hardcoded is now seeded by migration).
    // The collector rides the same shared diesel pool as the gatekeeper (see
    // `diesel_pool` above). User-created remotes persist there; a remote's config
    // JSON may carry pharmacy credentials, so the whole surface is Owner-gated
    // like the rest of the admin API.
    let gated_collector = collector_rust::setup_collector(diesel_pool.clone())
        .context("failed to set up collector")?
        .layer(gatekeeper_auth_layer.clone());

    // The real `/tunnel` surface (replacing the former api_stubs stub). It's
    // Owner-gated like the rest of the admin API. Settings (incl. the relay
    // connection) are persisted in the shared database over the same diesel pool
    // and controlled through the API; the host's build-time `tunnel_seed` fills
    // only fields that are still unconfigured (see
    // `tunnel_rust::SqliteTunnelStore::seed_if_absent`).
    let tunnel_config = tunnel_rust::TunnelConfig {
        loopback_base_url: runtime.loopback_base_url(),
        seed: tunnel_seed,
    };
    // `setup_tunnel` hands back the `/tunnel` router plus the in-process
    // `TunnelControl` seam (which implements `TunnelService`). The daemon drives
    // a `/health` probe — against the app-layer `/health` route mounted below —
    // through the reqwest adapter to verify reachability.
    let health_probe: Arc<dyn tunnel_rust::HealthProbe> =
        Arc::new(tunnel_adapters::ReqwestHealthProbe::new());
    let tunnel = tunnel_rust::setup_tunnel(diesel_pool.clone(), &tunnel_config, health_probe)
        .context("failed to set up tunnel")?;
    let gated_tunnel = tunnel.router.layer(gatekeeper_auth_layer.clone());

    // The apps catalogue surface. `GET /apps` (list), the admin surface (`POST
    // /apps`, `GET`/`PUT`/`DELETE /apps/{id}`), and `PUT /home-screen` are
    // scope-gated on `wildflower/Apps.*` behind the gatekeeper bearer gate
    // (`gated_apps`, below). The launch route `POST /apps/{id}`
    // (`apps.launch_router`) is scope-gated on the `wildflower/launch` umbrella
    // behind the same bearer gate (`gated_launch`, below), with a per-app SMART
    // check in the handler; a forwarded launch rides the front trust boundary for
    // the redirect. A `requires_tunnel` launch resolves to
    // the tunnel's verified origin through the tunnel service (or fails 503
    // LaunchUnavailable when the tunnel can't be brought up). The apps slice derives
    // the loopback launch origin from `loopback_base_url`.
    let apps_config = AppsConfig {
        loopback_base_url: loopback_base_url.clone(),
    };
    // `TunnelControl` implements `TunnelService`, so it's handed straight in.
    let tunnel_service: Arc<dyn tunnel_rust::TunnelService> = Arc::new(tunnel.control.clone());

    // HFS's `base_url` tracks the tunnel's public host (see `hfs_base_url`): set
    // before serving, so a stored host that can't be one stops startup, then
    // re-set whenever the tunnel settings change.
    let mut tunnel_liveness = tunnel_service.subscribe();
    let public_host = tunnel_liveness.borrow_and_update().public_host.clone();
    hfs_base_url::point_hfs_at_public_host(&fhir_routers.hfs, public_host.as_deref())?;
    let hfs = fhir_routers.hfs.clone();
    tokio::spawn(hfs_base_url::follow_public_host(
        tunnel_liveness,
        public_host,
        move |public_host| {
            // `PUT /tunnel` refuses a host that can't be a base URL, so this
            // failing is a bug, not a settings mistake.
            if let Err(error) = hfs_base_url::point_hfs_at_public_host(&hfs, public_host) {
                tracing::error!("FHIR base URL left unchanged: {error:#}");
            }
        },
    ));
    // The per-app SMART launch-scope seam: resolves a SMART app's OAuth client
    // scopes so the launch handler can require the caller's grant to cover them.
    // The launch umbrella (`wildflower/launch`) is enforced separately by the
    // bearer gate + `Scoped<AppLauncher>` on the launch router (below).
    let launch_scopes: Arc<dyn AppLaunchScopes> = Arc::new(GatekeeperAppLaunchScopes {
        state: gatekeeper.state.clone(),
    });

    // A loopback launch hands the resolved URL to the host's on-device webview
    // handle, which opens it in a native popup (the server 204s).
    let apps = setup_apps(
        diesel_pool,
        &apps_config,
        Arc::clone(&tunnel_service),
        host.on_device_webview_handle,
        launch_scopes,
    )
    .context("failed to set up apps")?;
    let gated_apps = apps.gated_router.layer(gatekeeper_auth_layer.clone());
    // The launch surface, scope-gated on the `wildflower/launch` umbrella: wrapped
    // by the SAME bearer gate as the admin surface so the `Scoped<AppLauncher>`
    // extractor has the caller's scope claims (the per-app SMART check then runs
    // in-handler).
    let gated_launch = apps.launch_router.layer(gatekeeper_auth_layer.clone());

    // The data-management surface (`/databases`): export + delete the host's
    // SQLite databases. It owns no store — it works at the file level on the
    // same `app_data_dir` the databases above live in — so the server passes the
    // directory plus the catalogue (the slice has no built-in knowledge of which
    // databases exist; the user-facing strings live here). Authenticated behind
    // the gatekeeper bearer gate, then authorized per database (NOT a blanket
    // owner gate):
    // Each database's export/delete is gated by the scope matching the *kind* of
    // data it holds (server policy — the slice enforces whatever scope we name
    // here): the FHIR clinical database by the SMART FHIR `system/*` grammar, the
    // app-data database by the Wildflower `wildflower/*` grammar. An owner token
    // (`system/*.cruds` + `wildflower/*.cruds`) covers both; a narrower token can
    // export only what it can read. The scopes are built from `scopes-rust`'s
    // typed constructors (tested there) rather than parsed from strings, so a
    // typo is a compile error, never a silent `Unknown` scope.
    let databases_config = databases_rust::DatabasesConfig {
        data_dir: runtime.app_data_dir.clone(),
        databases: vec![
            databases_rust::DatabaseDescriptor {
                id: HEALTH_DATA_DB.to_owned(),
                label: "Health data".to_owned(),
                description:
                    "Your FHIR clinical records — patients, observations, and the rest of your chart."
                        .to_owned(),
                read_scope: scopes_rust::Scope::fhir_system_all(scopes_rust::Permission::READ_SEARCH),
                delete_scope: scopes_rust::Scope::fhir_system_all(scopes_rust::Permission::DELETE),
            },
            databases_rust::DatabaseDescriptor {
                id: WILDFLOWER_DB.to_owned(),
                label: "Wildflower app data".to_owned(),
                description: "App state — access grants, tunnel settings, and the apps catalogue."
                    .to_owned(),
                read_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::READ),
                delete_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::DELETE),
            },
        ],
    };
    let gated_databases =
        databases_rust::setup_databases(&databases_config).layer(gatekeeper_auth_layer);

    // The webview page is NOT served from this origin — it loads from
    // the Vite dev server (`http://localhost:1420`) in dev and Tauri's
    // asset protocol (`tauri://localhost`) in builds, while API fetches
    // target this server absolutely (the React tauri entry's
    // `apiBaseUrl`). So every API request is cross-origin and the API
    // must impose no CORS restriction beyond refusing credentials (see
    // `api_cors_layer`). Trust doesn't come from CORS here anyway: the
    // loopback gate rejects non-local peers and auth rides the bearer
    // header.
    let api_router = Router::new()
        .merge(gatekeeper.router)
        .merge(gated_fhir_r4)
        .merge(gated_ohif_server)
        .merge(gated_collector)
        .merge(gated_tunnel)
        // The app-layer `/health`: an unauthenticated liveness endpoint the
        // tunnel's reachability probe round-trips through the relay. Ungated so
        // the probe (and any external uptime check) needs no bearer token. The
        // reusable router comes from the core; `AlwaysHealthy` is the trivial
        // service until real per-slice checks are wired.
        .merge(shared_structures_rust::health_check::health_router(
            Arc::new(shared_structures_rust::health_check::AlwaysHealthy),
        ))
        .merge(gated_apps)
        // The launch surface, bearer-gated like `gated_apps` so the
        // `Scoped<AppLauncher>` extractor sees the caller's scope claims (it gates
        // on the `wildflower/launch` umbrella; the per-app SMART check runs
        // in-handler). Built as its own gated router so its raised body limit /
        // exemptions can differ from the admin surface.
        .merge(gated_launch)
        .merge(gated_databases)
        // No slice claimed the route: `404`, pointing a browser at the hosted
        // owner UI (the server serves no UI of its own). See `not_found.rs`.
        .fallback(not_found::fallback(Arc::new(not_found::NotFoundConfig {
            owner_ui_base,
            loopback_base_url: loopback_base_url.clone(),
        })))
        // Desktop loopback-owner trust (see `inject_loopback_owner_token`):
        // present the host owner token for a direct-local caller so the webview
        // authenticates on connection provenance. Inner of CORS (which answers preflight
        // first) and of the loopback-peer gate applied below.
        .layer(axum::middleware::from_fn_with_state(
            LoopbackOwnerTrust {
                token_rx: host.host_owner_token_sender.subscribe(),
            },
            inject_loopback_owner_token,
        ));

    // Defense-in-depth: gate the entire API surface on a loopback peer address.
    // Every endpoint here is meant to be reached only over the loopback socket —
    // directly, or relayed by the trusted front, which proxies remote callers
    // from loopback (and is distinguished downstream by the `Forwarded` header).
    // A genuinely non-loopback peer is rejected with `403` before any handler
    // runs, so even an ungated, CORS-permissive endpoint like `POST /apps/{id}`
    // (which can open a native popup on the owner's device) can't be driven by a
    // non-loopback client. Applied outermost (after CORS) so it runs first. See
    // `require_loopback_peer_middleware` for how forwarded callers pass and why
    // re-gating the gatekeeper's already-gated routes is harmless.
    let api_router = api_router
        .layer(require_loopback_peer_middleware())
        .layer(api_cors_layer());

    axum::serve(
        listener,
        api_router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.cancelled_owned())
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::api_cors_layer;
    use tower::ServiceExt;

    /// A preflight from a public origin asking to reach this private-network
    /// server is answered with `Access-Control-Allow-Private-Network: true`;
    /// without it, Chrome blocks the hosted owner UI from calling loopback.
    #[tokio::test]
    async fn a_private_network_preflight_is_allowed() {
        let router = axum::Router::new()
            .route("/fhir-r4/metadata", axum::routing::get(|| async { "ok" }))
            .layer(api_cors_layer());
        let preflight = axum::http::Request::options("/fhir-r4/metadata")
            .header("origin", "https://wildflowerhealth.io")
            .header("access-control-request-method", "GET")
            .header("access-control-request-private-network", "true")
            .body(axum::body::Body::empty())
            .expect("preflight request");
        let response = router.oneshot(preflight).await.expect("preflight");
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-private-network")
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("https://wildflowerhealth.io")
        );
    }

    /// A cross-origin request is never told it may send credentials: the API
    /// authenticates by bearer alone, so no ambient credential may ride.
    #[tokio::test]
    async fn cross_origin_credentials_are_never_allowed() {
        let router = axum::Router::new()
            .route("/fhir-r4/metadata", axum::routing::get(|| async { "ok" }))
            .layer(api_cors_layer());
        let preflight = axum::http::Request::options("/fhir-r4/metadata")
            .header("origin", "https://evil.example")
            .header("access-control-request-method", "GET")
            .header("access-control-request-headers", "authorization")
            .body(axum::body::Body::empty())
            .expect("preflight request");
        let response = router.oneshot(preflight).await.expect("preflight");
        assert!(response
            .headers()
            .get("access-control-allow-credentials")
            .is_none());
        // `Authorization` is still allowed, so bearer clients keep working.
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-headers")
                .and_then(|value| value.to_str().ok()),
            Some("authorization")
        );
    }
}

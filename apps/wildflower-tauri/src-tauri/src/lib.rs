mod bridge;
mod native_webview_handle;
mod spa;
mod tunnel_adapters;

use anyhow::Context;
use apps_rust::{setup_apps, AppsConfig, OwnerAuth, SelfHostedAppsService};
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{
    ensure_bearer_header, is_pre_auth_public_path, layer_router_with_gatekeeper_auth_gating,
    layer_router_with_loopback_peer_gating, setup_gatekeeper, verify_owner_bearer,
    GatekeeperConfig,
};
use shared_structures_rust::ServerRuntimeConfig;
use shared_structures_server_rust::{ProxyTable, TunnelSubdomainReverseProxy};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use url::Url;

// Loopback hostname/port for the embedded API server, derived at compile time
// from the SINGLE SOURCE OF TRUTH
// `apps/wildflower-tauri/tauri-shared-config.json`. `build.rs` reads that file
// and re-emits these as `rustc-env` vars; the TS shell injects the same file
// as `WILDFLOWER_LOOPBACK_ORIGIN` (see `vite.config.ts` and `src/main.tsx`).
// Changing the JSON updates both sides — they can't drift. A non-numeric port
// in the JSON fails this `const` parse at compile time rather than at bind
// time.
const LOOPBACK_HOSTNAME: &str = env!("WILDFLOWER_LOOPBACK_HOSTNAME");
const LOOPBACK_PORT: u16 = match u16::from_str_radix(env!("WILDFLOWER_LOOPBACK_PORT"), 10) {
    Ok(port) => port,
    Err(_) => panic!("WILDFLOWER_LOOPBACK_PORT (from tauri-shared-config.json) must be a u16"),
};

// The host's granted-scope string, also sourced from
// `apps/wildflower-tauri/tauri-shared-config.json` (re-emitted by `build.rs`).
// The TS shell reads the same value as `WILDFLOWER_LOCAL_GRANTED_SCOPES`
// (`vite.config.ts`), so the host's device-authorization request can't drift
// from what gatekeeper seeds. gatekeeper seeds its first-party client's
// `allowed_scopes` and mints the host owner token from this set (asserting it
// covers `WILDFLOWER_WIDEST_SCOPES`).
const LOCAL_GRANTED_SCOPES: &str = env!("WILDFLOWER_LOCAL_GRANTED_SCOPES");

// Filenames of the host's SQLite databases under the shared app-data dir. These
// are the single source of truth for each database's on-disk name: the slice
// that opens it AND the data-management catalogue (`/databases`) reference the
// same const, so adding or renaming a database is one edit here. The host owns
// these names — `databases-rust` has no built-in knowledge of them.
const HEALTH_DATA_DB: &str = "health-data.sqlite";
const WILDFLOWER_DB: &str = "wildflower.sqlite";

/// The host's [`apps_rust::OwnerAuth`]: a loopback launch is owner-gated by the
/// same Owner-bearer check gatekeeper applies to its `/access/*` admin surface
/// (delegated to [`verify_owner_bearer`]), so the on-device popup can't be driven
/// by a non-owner local process even though it cleared the loopback-peer gate. A
/// forwarded launch never reaches this — the launch handler skips the owner check
/// for the front-trusted remote path.
#[derive(Clone)]
struct GatekeeperOwnerAuth {
    state: gatekeeper_rust::AppState,
}

impl OwnerAuth for GatekeeperOwnerAuth {
    fn is_owner(&self, headers: &axum::http::HeaderMap, served_origin: &str) -> bool {
        verify_owner_bearer(&self.state, headers, served_origin)
    }
}

/// Desktop loopback-owner trust: presents the host's owner `Authorization:
/// Bearer` header on behalf of a direct-local caller. Holds a `watch::Receiver`
/// for the minted host owner token; each request reads the current token off
/// the channel and builds the header inline. The token only changes when
/// `setup_gatekeeper` re-mints, and loopback owner traffic is low-volume, so
/// rebuilding the short header string per request is negligible — not worth
/// caching behind a lock.
#[derive(Clone)]
struct LoopbackOwnerTrust {
    /// The channel `setup_gatekeeper` publishes the minted host owner token on.
    token_rx: tokio::sync::watch::Receiver<Option<String>>,
}

/// Present the host's own owner token on behalf of a **direct-local** request —
/// one that reached the loopback API over a loopback socket peer AND without a
/// `Forwarded` header (a tunnel-relayed remote caller carries one). WKWebView
/// won't carry the host-planted `wf_auth` cookie cross-site (wry drops
/// `SameSite=None`, and WebKit won't send a `Secure` cookie over http loopback),
/// so the desktop webview authenticates on *connection provenance* instead: the
/// host attaches its owner bearer, and the gatekeeper gate and emr's own JWKS
/// bearer check both validate it normally — no slice-side special-casing.
///
/// SECURITY: this trusts *every* direct-loopback caller as owner, not only the
/// webview — any local process on the machine reaches the same surface. That is
/// the desktop single-user trust model (a local process running as the user can
/// already read the app's data on disk). It stays gated on `!forwarded` so it
/// never extends to tunnel-relayed remote callers, and skips gatekeeper's
/// pre-auth public surface ([`is_pre_auth_public_path`]) where a stray owner
/// bearer could confuse client authentication. A request that already presents
/// its own bearer is left untouched (via the shared [`ensure_bearer_header`]).
/// Applied inside the loopback-peer gate, so a non-loopback peer is already
/// rejected before this runs.
async fn inject_loopback_owner_token(
    axum::extract::State(trust): axum::extract::State<LoopbackOwnerTrust>,
    connect_info: Option<axum::Extension<axum::extract::ConnectInfo<SocketAddr>>>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let peer_is_loopback = connect_info
        .is_some_and(|axum::Extension(axum::extract::ConnectInfo(addr))| addr.ip().is_loopback());
    let forwarded = shared_structures_rust::served_origin::is_forwarded(req.headers());
    let is_public_surface = is_pre_auth_public_path(req.uri().path());

    if should_present_owner_token(peer_is_loopback, forwarded, is_public_surface) {
        if let Some(bearer) = current_owner_bearer(&trust) {
            ensure_bearer_header(req.headers_mut(), &bearer);
        }
    }
    next.run(req).await
}

/// The stamp gate: present the owner bearer only for a **direct-local**,
/// non-forwarded request that isn't on the pre-auth public surface. Pulled out
/// as a pure conjunction so the security-critical rule is unit-tested — e.g. an
/// inverted `forwarded` check (which would extend owner trust to tunnel-relayed
/// remote callers) fails the test rather than shipping silently.
fn should_present_owner_token(
    peer_is_loopback: bool,
    forwarded: bool,
    is_public_surface: bool,
) -> bool {
    peer_is_loopback && !forwarded && !is_public_surface
}

/// The current owner `Authorization: Bearer` header, built from the latest
/// token on the watch channel. `None` before the host mints a token (or on the
/// impossible header-parse failure). `borrow()` takes `&self` and needs no lock,
/// so concurrent loopback requests read the shared receiver freely.
fn current_owner_bearer(trust: &LoopbackOwnerTrust) -> Option<axum::http::HeaderValue> {
    let token = trust.token_rx.borrow().clone();
    token.and_then(|t| axum::http::HeaderValue::from_str(&format!("Bearer {t}")).ok())
}

async fn run_server(
    runtime: ServerRuntimeConfig,
    publishers: bridge::BridgePublishers,
    app_handle: tauri::AppHandle,
) -> anyhow::Result<()> {
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
    let loopback_origin = loopback_base_url.origin().ascii_serialization();
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.app_data_dir.join(HEALTH_DATA_DB),
        // HFS-enforced auth: every FHIR request must carry a Bearer JWT
        // signed by a gatekeeper-issued key. `iss` is pinned to
        // [`shared_structures_rust::CANONICAL_ISSUER`] by both gatekeeper
        // (at mint) and emr-rust (at validation).
        jwks_url: Some(format!("{loopback_origin}/.well-known/jwks.json")),
    };
    let gatekeeper_config = GatekeeperConfig {
        loopback_base_url: loopback_base_url.clone(),
        granted_scopes: LOCAL_GRANTED_SCOPES
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
    };

    // One shared SQLite database for all persistence-rust-backed slices
    // (gatekeeper, and the tunnel slice); each runs its own namespaced
    // migrations on it. (The FHIR/emr store is managed separately by
    // helios-persistence.)
    let db = persistence_rust::Connection::open(&runtime.app_data_dir.join(WILDFLOWER_DB))
        .context("failed to open shared database")?;

    // Bind BEFORE minting/publishing the Owner token: `setup_gatekeeper`
    // pushes the freshly-minted token onto the bridge publisher, and the
    // bridge plants it as the webview's `wf_auth` cookie (and emits a
    // contentless `AuthTokenIssued` notify to flip the page's
    // auth-readiness signal). If the port were already taken, minting
    // first would mean planting a full-Owner bearer cookie while a
    // *foreign* process owns `127.0.0.1:<port>`. Binding first guarantees
    // the token is only ever minted once this process owns the port.
    let listener = TcpListener::bind(&loopback_host)
        .await
        .with_context(|| format!("failed to bind to {loopback_host}"))?;

    let fhir_r4_router =
        setup_fhir_r4(&runtime, &emr_config).context("failed to set up FHIR R4 router")?;
    // `setup_gatekeeper` publishes the freshly-minted host owner token (and
    // device-consent heads) through the bridge publishers; `bridge::attach_bridge`
    // documents how the resident task delivers them to the webview.
    let gatekeeper = setup_gatekeeper(
        db.clone(),
        &gatekeeper_config,
        &publishers.host_owner_token_sender,
        publishers.active_device_user_code_sender,
    )
    .context("failed to set up gatekeeper")?;

    // The FHIR router carries discovery docs (metadata, SMART well-known) that a
    // client fetches before it holds a token, so those paths are exempted from
    // the bearer gate; every other `/fhir-r4/*` path still requires a token.
    let gated_fhir_r4 = layer_router_with_gatekeeper_auth_gating(
        fhir_r4_router,
        gatekeeper.state.clone(),
        emr_rust::UNAUTHENTICATED_FHIR_PATHS,
    );

    // The real `/collector/remotes` surface (replacing the former api_stubs
    // stub — the demo FHIR remote it hardcoded is now seeded by migration).
    // User-created remotes persist in the shared database; a remote's config
    // JSON may carry pharmacy credentials, so the whole surface is Owner-gated
    // like the rest of the admin API.
    let gated_collector = layer_router_with_gatekeeper_auth_gating(
        collector_rust::setup_collector(db.clone()).context("failed to set up collector")?,
        gatekeeper.state.clone(),
        &[],
    );

    // The real `/tunnel` surface (replacing the former api_stubs stub). It's
    // Owner-gated like the rest of the admin API. Settings (incl. the relay
    // connection) are persisted in SQLite and controlled through the API; there
    // is no UI and no env seeding yet, so on a fresh install the relay is
    // unconfigured and toggling the tunnel on just reports that.
    // Build-time tunnel connection defaults, baked into the binary so a
    // reinstall re-seeds them (see `tunnel_rust::TunnelStore::seed_if_absent`,
    // which only fills unconfigured fields). The relay is seeded only when all
    // four fields are present at build time.
    //
    // SECURITY: `WILDFLOWER_TUNNEL_RELAY_TOKEN` is compiled into the distributed
    // binary (an extractable artifact) — an accepted trade-off so the relay
    // connection survives reinstalls, token included, without re-entry.
    fn tunnel_seed_from_build_env() -> tunnel_rust::SettingsSeed {
        // Treat an empty value as absent: a blank `.env` entry is forwarded by
        // `dotenvy` as `Some("")`, which would otherwise seed a half-configured
        // relay (and an empty token reads back as unconfigured anyway).
        let non_empty = |value: &'static str| (!value.is_empty()).then_some(value);
        let relay = match (
            option_env!("WILDFLOWER_TUNNEL_RELAY_REMOTE_ADDR").and_then(non_empty),
            option_env!("WILDFLOWER_TUNNEL_RELAY_TOKEN").and_then(non_empty),
            option_env!("WILDFLOWER_TUNNEL_RELAY_PUBLIC_KEY").and_then(non_empty),
            option_env!("WILDFLOWER_TUNNEL_RELAY_SERVICE_NAME").and_then(non_empty),
        ) {
            (Some(remote_addr), Some(token), Some(public_key), Some(service_name)) => {
                Some(tunnel_rust::RelaySettings {
                    remote_addr: remote_addr.to_owned(),
                    token: token.to_owned(),
                    public_key: public_key.to_owned(),
                    service_name: service_name.to_owned(),
                })
            }
            _ => None,
        };
        tunnel_rust::SettingsSeed {
            public_host: option_env!("WILDFLOWER_TUNNEL_PUBLIC_HOST")
                .and_then(non_empty)
                .map(str::to_owned),
            relay,
        }
    }

    let tunnel_config = tunnel_rust::TunnelConfig {
        loopback_base_url: runtime.loopback_base_url(),
        seed: tunnel_seed_from_build_env(),
    };
    // `setup_tunnel` hands back the `/tunnel` router plus the in-process
    // `TunnelControl` seam (which implements `TunnelService`). The daemon drives
    // a `/health` probe — against the app-layer `/health` route mounted below —
    // through the reqwest adapter to verify reachability.
    let health_probe: Arc<dyn tunnel_rust::HealthProbe> =
        Arc::new(tunnel_adapters::ReqwestHealthProbe::new());
    let tunnel = tunnel_rust::setup_tunnel(db.clone(), &tunnel_config, health_probe)
        .context("failed to set up tunnel")?;
    let gated_tunnel =
        layer_router_with_gatekeeper_auth_gating(tunnel.router, gatekeeper.state.clone(), &[]);

    // The apps catalogue surface. `GET /apps` (list), the cloud-admin write
    // surface (POST/PATCH/DELETE), and `PATCH /apps/{id}/placement` are
    // owner-gated through the gatekeeper (`apps.gated_router`, below). The launch
    // route `POST /apps/{id}` (`apps.launch_router`) is merged ungated at the
    // router level: a loopback launch is owner-gated in-handler via `owner_auth`,
    // a forwarded launch rides the front trust boundary. A `requires_tunnel`
    // launch resolves to the tunnel's verified origin through the tunnel service
    // (or fails 503 LaunchUnavailable when the tunnel can't be brought up). The
    // apps slice derives the launch origin and the self-hosted listeners'
    // hostname from `loopback_base_url`, so they can't drift.
    let apps_config = AppsConfig {
        loopback_base_url: loopback_base_url.clone(),
    };
    // `TunnelControl` implements `TunnelService`, so it's handed straight in.
    let tunnel_service: Arc<dyn tunnel_rust::TunnelService> = Arc::new(tunnel.control.clone());
    // Install the host's on-device webview handle: for a loopback caller the
    // launch handler hands it the resolved URL to open in a native webview popup
    // (the server 204s, so the SPA stays mounted). See `native_webview_handle`.
    let webview_handle: Arc<dyn apps_rust::OnDeviceWebviewHandle> = Arc::new(
        native_webview_handle::NativeWebviewHandle::new(app_handle.clone()),
    );
    // The loopback launch owner-gate: the same Owner-bearer check the admin
    // surface uses (a header-derived loopback provenance isn't a sufficient gate
    // on its own — the network loopback-peer gate is the other half).
    let owner_auth: Arc<dyn OwnerAuth> = Arc::new(GatekeeperOwnerAuth {
        state: gatekeeper.state.clone(),
    });
    let apps = setup_apps(
        db,
        &apps_config,
        Arc::clone(&tunnel_service),
        webview_handle,
        owner_auth,
    )
    .context("failed to set up apps")?;
    let gated_apps =
        layer_router_with_gatekeeper_auth_gating(apps.gated_router, gatekeeper.state.clone(), &[]);

    // The data-management surface (`/databases`): export + delete the host's
    // SQLite databases. It owns no store — it works at the file level on the
    // same `app_data_dir` the databases above live in — so the host passes the
    // directory plus the catalogue (the slice has no built-in knowledge of which
    // databases exist; the user-facing strings live here). Owner-gated like the
    // rest of the admin API.
    let databases_config = databases_rust::DatabasesConfig {
        data_dir: runtime.app_data_dir.clone(),
        databases: vec![
            databases_rust::DatabaseDescriptor {
                id: HEALTH_DATA_DB.to_owned(),
                label: "Health data".to_owned(),
                description:
                    "Your FHIR clinical records — patients, observations, and the rest of your chart."
                        .to_owned(),
            },
            databases_rust::DatabaseDescriptor {
                id: WILDFLOWER_DB.to_owned(),
                label: "Wildflower app data".to_owned(),
                description: "App state — access grants, tunnel settings, and the apps catalogue."
                    .to_owned(),
            },
        ],
    };
    let gated_databases = layer_router_with_gatekeeper_auth_gating(
        databases_rust::setup_databases(&databases_config),
        gatekeeper.state.clone(),
        &[],
    );
    // The webview page is NOT served from this origin — it loads from
    // the Vite dev server (`http://localhost:1420`) in dev and Tauri's
    // asset protocol (`tauri://localhost`) in builds, while API fetches
    // target this server absolutely (the React tauri entry's
    // `apiBaseUrl`). So every API request is cross-origin and the API
    // must impose no CORS restriction. `very_permissive()` mirrors the
    // requesting origin/method/headers back (rather than `*`, whose
    // header wildcard the CORS spec defines as excluding
    // `Authorization` — the one header the bearer clients need).
    // Trust doesn't come from CORS here anyway: the loopback gate
    // rejects non-local peers and auth rides the bearer header.
    //
    // Static "installed apps" are served from this directory under app-data at
    // request time (the apps slice's `SelfHostedAppsService` builds each app's
    // file-serving router from its `<id>/` subdirectory here). Created up front
    // so it's a stable, discoverable place to drop an app's files into; an
    // empty/missing dir just 404s. Best-effort — a creation failure only means
    // the apps routes 404 until it exists, so it must not abort server startup.
    let installed_apps_dir = runtime.app_data_dir.join("installed-apps");
    if let Err(error) = std::fs::create_dir_all(&installed_apps_dir) {
        tauri_plugin_log::log::warn!(
            "failed to create installed-apps dir {}: {error}",
            installed_apps_dir.display()
        );
    }

    // The `id -> loopback port` table the reverse proxy reads per request and
    // the apps slice registers each self-hosted app into. A cloneable `Arc`
    // handle, so the registration the slice does is visible to the live proxy.
    let proxy_table = ProxyTable::new();

    // The whole API stack — built first because it's the reverse proxy's
    // fallback, handed in at construction. A forwarded request that doesn't
    // match a self-hosted subdomain (and every loopback request) runs this.
    let api_router = Router::new()
        .merge(gatekeeper.router)
        .merge(gated_fhir_r4)
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
        // The launch route, merged AFTER the bearer-gated `gated_apps` so it
        // stays ungated at the router level (axum layers only the routes present
        // when `.layer()` ran). It's still under the outer loopback-peer gate;
        // the launch handler owner-gates the loopback popup in-handler.
        .merge(apps.launch_router)
        .merge(gated_databases)
        .fallback(spa::handle_serving_spa_html)
        // Desktop loopback-owner trust (see `inject_loopback_owner_token`):
        // present the host owner token for a direct-local caller so the webview
        // authenticates on connection provenance rather than the cross-site
        // cookie WKWebView won't carry. Inner of CORS (which answers preflight
        // first) and of the loopback-peer gate applied below.
        .layer(axum::middleware::from_fn_with_state(
            LoopbackOwnerTrust {
                token_rx: publishers.host_owner_token_sender.subscribe(),
            },
            inject_loopback_owner_token,
        ))
        .layer(CorsLayer::very_permissive());

    // Defense-in-depth: gate the entire API surface on a loopback peer address.
    // Every endpoint here is meant to be reached only over the loopback socket —
    // directly, or relayed by the trusted front, which proxies remote callers
    // from loopback (and is distinguished downstream by the `Forwarded` header).
    // A genuinely non-loopback peer is rejected with `403` before any handler
    // runs, so even an ungated, CORS-permissive endpoint like `POST /apps/{id}`
    // (which can open a native popup on the owner's device) can't be driven by a
    // non-loopback client. Applied outermost (after CORS) so it runs first. See
    // `layer_router_with_loopback_peer_gating` for how forwarded callers pass and
    // why re-gating the gatekeeper's already-gated routes is harmless.
    let api_router = layer_router_with_loopback_peer_gating(api_router);

    // The reverse proxy wraps the API stack as the outermost layer: a forwarded
    // request whose `Forwarded` host matches `<app-id>.<configured-public-host>`
    // is reverse-proxied to that app's loopback port (the same listener a local
    // launch reaches); loopback and apex-host traffic runs the api_router.
    let proxy = TunnelSubdomainReverseProxy::new(
        loopback_base_url.clone(),
        Arc::clone(&tunnel_service),
        api_router,
        proxy_table.clone(),
    );

    // The apps slice owns the self-hosted lifecycle. Each self-hosted app gets
    // its own dedicated loopback origin (`http://{loopback_hostname}:{port}/`) —
    // its own security context (own storage, own cookies, no Same-Origin Policy
    // share with the main API) — and is registered into `proxy_table` so it's
    // also reachable remotely at `<app-id>.<public-host>` for forwarded traffic.
    // The DB row's `port` is the source of truth for the bind; the apps slice
    // renders the launch target from the same value, so redirect and listener
    // can't drift. Seed-driven today (the static `self_hosted_apps` catalogue); the
    // start/stop calls also work at runtime for restartless install. A failure
    // to bring one app online must not abort startup, so it's logged and skipped.
    // The loopback API origin + tunnel feed the per-request template rendering
    // (`apiOrigin`) in each app's router — loopback callers get the loopback
    // origin, forwarded callers `https://<public_host>`.
    let self_hosted = SelfHostedAppsService::new(
        &loopback_base_url,
        installed_apps_dir,
        proxy_table,
        Arc::clone(&tunnel_service),
    );
    for app in &apps.self_hosted_apps {
        if let Err(error) = self_hosted.start(app).await {
            tauri_plugin_log::log::warn!("failed to start self-hosted app {}: {error}", app.id);
        }
    }
    // Hold the orchestrator for the process lifetime — dropping it would drop the
    // running listeners' shutdown signals and take the self-hosted apps offline.
    let _self_hosted = self_hosted;

    axum::serve(
        listener,
        proxy
            .into_router()
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// Build and run the Tauri application.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to start — an unrecoverable
/// windowing/context failure with no app handle through which to surface a
/// dialog, so dying with the error is the honest outcome. Recoverable startup
/// failures (e.g. the app-data directory) are handled inside `.setup()` where a
/// handle still exists.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // Gated web→host data-plane transport for the desktop sniffer's
            // untrusted content webview — allowlists the inner `_tag` so the page
            // can't forge control tags it would otherwise reach via a bus `emit`
            // grant. See capabilities/native-webview-window.json.
            browser_sniffer_tauri_rust::native_webview_data_plane_emit
        ])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Native web view, presenting external URLs with native chrome
        // and document-start JS injection — the native counterpart to the
        // browser-sniffer WebviewWindow path, which stays in place. iOS uses a
        // WKWebView, Android an android.webkit.WebView, desktop a Tauri
        // WebviewWindow (scoped by capabilities/native-webview-window.json).
        .plugin(tauri_plugin_native_webview::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Stdout only — no Webview target, so host logs never
                // re-enter the webview. Keeps the log flow one-way:
                // webview console → `bridge:Log` → here (a Webview
                // target would loop those right back out).
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .level(tauri_plugin_log::log::LevelFilter::Debug)
                // rathole logs every relay heartbeat/data-channel event at
                // debug — far too repetitive to read the tunnel lifecycle
                // through. Pin it to info; the tunnel slice's own
                // dial/probe/transition logs carry the timeline we care about.
                .level_for("rathole", tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            // Attach the bridge before the server task spawns: `listen`
            // registers synchronously, so the webview's `__Ready` (which
            // fires much later, once the bundle runs) can't be missed
            // even if the server is slow to boot. The bridge owns its
            // channel plumbing; the server task gets the publishers.
            let publishers = bridge::attach_bridge(app.handle());

            // Wire the CollectorBridge.webToHost listeners that manage the
            // sniffer child webview lifecycle (open / navigate / close).
            // Sniffer-emitted data-plane events (`bridge:ResponseStart`
            // etc.) reach the React SPA on the global Tauri event bus, but
            // never straight from the untrusted content webview: the host
            // allowlists their inner `_tag` first (the mobile channel's
            // `validate_native_webview_message`, the desktop content webview's
            // `native_webview_data_plane_emit` command) and re-broadcasts.
            browser_sniffer_tauri_rust::attach_browser_sniffer(app.handle());

            let error_handle = app.handle().clone();
            // The server task installs the apps on-device webview handle once
            // the apps slice is built; the handle opens launched apps in a
            // native webview popup, so it needs an app handle.
            let server_handle = app.handle().clone();

            // Hostname/port come from the shared `tauri-shared-config.json`
            // (see `LOOPBACK_HOSTNAME`/`LOOPBACK_PORT`), the same file the
            // TS `apiBaseUrl` reads.
            let loopback_base_url =
                Url::parse(&format!("http://{}:{}", LOOPBACK_HOSTNAME, LOOPBACK_PORT))?;

            tauri::async_runtime::spawn(async move {
                let runtime = ServerRuntimeConfig {
                    // Loopback-only: the OS rejects non-local peers at the
                    // socket, so the bearer secret is never the only thing
                    // between LAN peers and FHIR health data.
                    loopback_base_url,
                    app_data_dir,
                };

                if let Err(error) = run_server(runtime, publishers, server_handle).await {
                    tauri_plugin_log::log::error!("Wildflower server stopped: {error:?}");
                    // A failed/stopped server leaves the webview unable to
                    // reach the API at all (no token, no FHIR) — surface it
                    // with a native dialog instead of dying silently in the
                    // logs. A native dialog (not a webview message) is used
                    // deliberately: it shows even when the webview itself can't
                    // load. Blocking is fine here — the server is already dead.
                    error_handle
                        .dialog()
                        .message(format!("Wildflower server stopped: {error:#}"))
                        .kind(MessageDialogKind::Error)
                        .title("Wildflower")
                        .blocking_show();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::should_present_owner_token;

    /// The owner bearer is stamped only for a direct-local, non-forwarded request
    /// off the pre-auth public surface. Each guard, flipped alone, must withhold
    /// the stamp — most critically an inverted `forwarded` check must NOT extend
    /// owner trust to a tunnel-relayed remote caller.
    #[test]
    fn owner_token_presented_only_for_direct_local_private_requests() {
        // The one case that stamps: loopback peer, not forwarded, not public.
        assert!(should_present_owner_token(true, false, false));
        // Not a loopback peer → never (the loopback-peer gate rejects it anyway).
        assert!(!should_present_owner_token(false, false, false));
        // Forwarded (tunnel-relayed) → never, even from a loopback proxy peer.
        assert!(!should_present_owner_token(true, true, false));
        // Pre-auth public surface (`/oauth`, `/.well-known`) → never.
        assert!(!should_present_owner_token(true, false, true));
    }
}

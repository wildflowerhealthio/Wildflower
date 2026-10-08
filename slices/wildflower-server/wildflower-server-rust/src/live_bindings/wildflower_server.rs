//! The server's composition: [`set_up`] opens the server's databases, sets up
//! every server slice, joins them through [`crate::adapters`], wraps them in
//! the [`crate::http`] layers once per listener, binds the loopback port and
//! opens the tunnel listener; [`WildflowerServer`] serves the result on both.

use std::future::IntoFuture;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use apps_rust::{ports::AppLaunchScopes, setup_apps, AppsConfig};
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig};
use gatekeeper_rust::{
    gatekeeper_auth_middleware, require_loopback_peer_middleware, setup_gatekeeper,
    GatekeeperConfig,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tunnel_rust::{TunnelDaemon, TunnelStream};

use crate::adapters::app_launch_scopes::GatekeeperAppLaunchScopes;
use crate::adapters::health_probe::ReqwestHealthProbe;
use crate::domain::reachability_monitor::ReachabilityMonitor;
use crate::http::health::ServerHealthChecks;
use crate::http::middleware::cors::api_cors_layer;
use crate::http::middleware::forwarded_request_layer::{self, ForwardedRequestSenders};
use crate::http::middleware::loopback_owner_trust::{
    inject_loopback_owner_token, LoopbackOwnerTrust,
};
use crate::http::middleware::tunnel_front::{stamp_tunnel_forwarded, TunnelFront};
use crate::http::not_found;
use crate::http::tunnel_listener::{TunnelListener, TunnelVisitor};
use crate::{HostPorts, ServerObservers, WildflowerServerConfig};

// Filenames of the server's SQLite databases in its folder. These
// are the single source of truth for each database's on-disk name: the slice
// that opens it AND the data-management catalogue (`/databases`) reference the
// same const, so adding or renaming a database is one edit here. The server owns
// these names — `databases-rust` has no built-in knowledge of them.
const HEALTH_DATA_DB: &str = "health-data.sqlite";
const WILDFLOWER_DB: &str = "wildflower.sqlite";

/// How many visitor streams the tunnel may hand over before the tunnel
/// listener takes them. Past this, the tunnel waits.
const TUNNEL_STREAM_BACKLOG: usize = 64;

/// A composed server bound to the loopback port, with its tunnel listener,
/// ready to [`serve`](Self::serve).
pub struct WildflowerServer {
    /// The loopback port local clients, and a front run on this machine, use.
    loopback_listener: TcpListener,
    /// What the loopback listener serves: the API behind the loopback owner
    /// trust and the loopback-peer gate.
    loopback_router: Router,
    /// The visitor streams the tunnel hands over.
    tunnel_listener: TunnelListener,
    /// What the tunnel listener serves: the API behind the tunnel front,
    /// with no loopback trust.
    tunnel_router: Router,
    /// A sender onto the tunnel listener, for
    /// [`tunnel_stream_tx`](Self::tunnel_stream_tx).
    #[cfg(feature = "test-support")]
    tunnel_stream_tx: mpsc::Sender<TunnelStream>,
    /// The tunnel's supervisor, which dials the relay until it's dropped. The
    /// server holds it so the tunnel runs for exactly as long as the server
    /// does.
    tunnel_daemon: TunnelDaemon,
    /// The monitor probing the server's `/health` through its public origin,
    /// which stops when it's dropped. Held for the same reason.
    reachability_monitor: ReachabilityMonitor,
}

impl WildflowerServer {
    /// A sender onto the tunnel listener, as the tunnel holds: each stream
    /// sent is served as a visitor's connection through the tunnel. Test
    /// support only (the `test-support` feature).
    #[cfg(feature = "test-support")]
    #[must_use]
    pub fn tunnel_stream_tx(&self) -> mpsc::Sender<TunnelStream> {
        self.tunnel_stream_tx.clone()
    }

    /// Serve the composed API on the bound loopback port and the tunnel
    /// listener until `shutdown` is cancelled. Cancelling stops both accepting
    /// connections, and the call returns `Ok` once the open ones on both
    /// close. The tunnel and the reachability monitor stop when the call
    /// returns.
    ///
    /// # Errors
    ///
    /// Returns an error if serving fails.
    pub async fn serve(self, shutdown: CancellationToken) -> anyhow::Result<()> {
        let Self {
            loopback_listener,
            loopback_router,
            tunnel_listener,
            tunnel_router,
            tunnel_daemon,
            reachability_monitor,
            // The `test-support` feature's `tunnel_stream_tx`.
            ..
        } = self;
        let loopback = axum::serve(
            loopback_listener,
            loopback_router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown.clone().cancelled_owned());
        let tunnel = axum::serve(
            tunnel_listener,
            tunnel_router.into_make_service_with_connect_info::<TunnelVisitor>(),
        )
        .with_graceful_shutdown(shutdown.cancelled_owned());
        tokio::try_join!(loopback.into_future(), tunnel.into_future())?;
        drop(reachability_monitor);
        drop(tunnel_daemon);
        Ok(())
    }
}

/// Set up every server slice over the host's databases, bind the API to the
/// loopback port and open the tunnel listener, ready to
/// [`serve`](WildflowerServer::serve).
///
/// `config` is what the host derived at build time or from its paths; `host`
/// carries its native adapters and its bridge's channels; `observers` carries
/// the channels the host watches the server through.
///
/// # Errors
///
/// Returns an error if the server's public host doesn't name an origin, the
/// server's folder can't be created, a scheduled database deletion can't be
/// applied, a database or store can't be opened, the loopback port can't be
/// bound, or a slice's setup fails.
///
/// # Remarks
///
/// Slices spawn background tasks (the tunnel supervisor, the reachability
/// monitor, gatekeeper's re-mint and sweeps) onto the runtime that runs this
/// future. They are not tied to the shutdown token: the tunnel supervisor and
/// the reachability monitor stop when the returned [`WildflowerServer`] is
/// dropped (at the latest when [`serve`](WildflowerServer::serve) returns), the
/// rest when that runtime shuts down.
pub async fn set_up(
    config: WildflowerServerConfig,
    host: HostPorts,
    observers: ServerObservers,
) -> anyhow::Result<WildflowerServer> {
    let WildflowerServerConfig {
        runtime,
        search_parameter_data_dir,
        owner_ui_base,
        host_owner_scopes,
        first_party_client_id,
        relay_settings,
        public_host,
    } = config;

    // The server's public origin, from its domain: what HFS's links and every app
    // launch name, and every token's `iss` and `aud`. It doesn't change while the
    // server runs.
    let public_origin = tunnel_rust::public_origin_url(&public_host)
        .context("the server's public host doesn't name an origin")?;

    // The server's folder holds its databases, and a server added since the
    // last start has none yet.
    std::fs::create_dir_all(&runtime.server_dir).with_context(|| {
        format!(
            "failed to create the server's folder {}",
            runtime.server_dir.display()
        )
    })?;

    // Apply any deletions the Owner scheduled from the data-management screen
    // BEFORE opening the databases below: the `/databases` DELETE can't remove a
    // file the owning slice holds open, so it drops a marker that we purge here,
    // while nothing has the file open yet.
    databases_rust::purge_pending_deletions(&runtime.server_dir)
        .context("failed to purge scheduled database deletions")?;

    let loopback_host = runtime.loopback_base_url_ref().authority().to_string();
    // The typed loopback base URL is the single source threaded into every
    // slice's config that renders it (gatekeeper / emr). `loopback_origin` is its
    // bare origin string (no trailing slash) for the few sub-URLs built by hand.
    let loopback_base_url = runtime.loopback_base_url();
    let loopback_origin = shared_structures_rust::origin_string(&loopback_base_url);
    let emr_config = EmrConfig {
        log_level: "debug".to_string(),
        db_file_path: runtime.server_dir.join(HEALTH_DATA_DB),
        // HFS-enforced auth: every FHIR request must carry a Bearer JWT
        // signed by a gatekeeper-issued key whose `iss` and `aud` are the
        // server's origin — set by gatekeeper at mint, checked by both
        // gatekeeper's gate and HFS.
        jwks_url: Some(format!("{loopback_origin}/.well-known/jwks.json")),
        search_parameter_data_dir,
        public_origin: public_origin.clone(),
    };
    let gatekeeper_config = GatekeeperConfig {
        loopback_base_url: loopback_base_url.clone(),
        server_origin: public_origin.clone(),
        host_owner_scopes,
        first_party_client_id,
        owner_ui_base: owner_ui_base.clone(),
    };

    // One shared SQLite database for all persistence-rust-backed slices; each
    // runs its own namespaced migrations on it. (The FHIR/emr store is managed
    // separately by helios-persistence.)
    let db_path = runtime.server_dir.join(WILDFLOWER_DB);
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
    let loopback_listener = TcpListener::bind(&loopback_host)
        .await
        .with_context(|| format!("failed to bind to {loopback_host}"))?;

    let fhir_routers = setup_fhir_r4(&runtime, &emr_config, revocation_store.clone())
        .context("failed to set up FHIR R4 router")?;
    let fhir_r4_router = fhir_routers.augmented_fhir_r4_router;

    // The app-wide diesel r2d2 pool, built once here on the same database file
    // `db` serves the other slices from and shared (cheap `Arc` clone) across
    // every diesel-backed slice — the gatekeeper OAuth surface, the collector
    // `/collector/remotes` surface, the apps surface and the request log's
    // `/requests` surface all run over it rather than each opening their
    // own. Its connections are NOT
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
        &host.host_owner_token_tx,
        host.active_pending_consent_tx,
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

    // The tunnel dials the relay from the server's record for as long as the
    // server runs, handing each visitor's stream, in process, to the tunnel
    // listener; it has no HTTP surface.
    let (tunnel_stream_tx, tunnel_stream_rx) = mpsc::channel::<TunnelStream>(TUNNEL_STREAM_BACKLOG);
    let tunnel_config = tunnel_rust::TunnelConfig {
        tunnel_stream_tx,
        relay_settings,
    };
    let tunnel_daemon = tunnel_rust::setup_tunnel(&tunnel_config);
    #[cfg(feature = "test-support")]
    let tunnel_stream_tx = tunnel_config.tunnel_stream_tx;
    // Whether a remote app can reach the server: the monitor GETs the server's
    // own `/health` (mounted below) through the public origin, so the request
    // goes out to the relay and back down the tunnel, and publishes the answer
    // on the host's channel, which outlives this server.
    let reachability_monitor = ReachabilityMonitor::spawn(
        Arc::new(ReqwestHealthProbe::new()),
        public_origin
            .join("health")
            .context("the server's public origin has no /health")?,
        observers.server_health_tx,
    );

    // The `/requests` surface: the request log the forwarded-request report
    // (below) feeds, over the same diesel pool. Scope-gated on
    // `wildflower/RequestLog.r` behind the bearer gate.
    let request_log = request_log_rust::setup_request_log(diesel_pool.clone())
        .context("failed to set up the request log")?;
    let gated_request_log = request_log.router.layer(gatekeeper_auth_layer.clone());

    // The apps surface, behind the gatekeeper bearer gate (`gated_apps`, below).
    // `GET /apps` (list), the admin surface (`POST /apps`,
    // `GET`/`PUT`/`DELETE /apps/{id}`), and `PUT /home-screen` are scope-gated on
    // `wildflower/Apps.*`. The launch route `POST /apps/{id}` is scope-gated on the
    // `wildflower/launch` umbrella, with a per-app SMART check in the handler; a
    // forwarded launch rides the front trust boundary for the redirect. Every
    // launch resolves `{origin}` to the server's public origin.
    let apps_config = AppsConfig {
        public_origin: public_origin.clone(),
    };
    // The per-app SMART launch-scope seam: resolves a SMART app's OAuth client
    // scopes so the launch handler can require the caller's grant to cover them.
    // The launch umbrella (`wildflower/launch`) is enforced separately by the
    // bearer gate + `Scoped<AppLauncher>` on the launch route (below).
    let launch_scopes: Arc<dyn AppLaunchScopes> = Arc::new(GatekeeperAppLaunchScopes {
        state: gatekeeper.state.clone(),
    });

    // A loopback launch hands the resolved URL to the host's on-device webview
    // handle, which opens it in a native popup (the server 204s).
    let apps = setup_apps(
        diesel_pool.clone(),
        &apps_config,
        host.on_device_webview_handle,
        launch_scopes,
    )
    .context("failed to set up apps")?;
    // The bearer gate gives every `Scoped<…>` extractor the caller's scope claims,
    // the launch's `Scoped<AppLauncher>` included (the per-app SMART check then
    // runs in-handler).
    let gated_apps = apps.router.layer(gatekeeper_auth_layer.clone());

    // The server's `/health`: the shared database pool and the tunnel's
    // health, checked in-process on each request.
    let health_checks = ServerHealthChecks {
        wildflower_db: diesel_pool,
        tunnel_connectivity: tunnel_daemon.connectivity(),
    };

    // The data-management surface (`/databases`): export + delete the server's
    // SQLite databases. It owns no store — it works at the file level on the
    // folder the databases above live in — so the server passes the
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
        data_dir: runtime.server_dir.clone(),
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
                description: "App state — access grants and the apps catalogue."
                    .to_owned(),
                read_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::READ),
                delete_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::DELETE),
            },
        ],
    };
    let gated_databases =
        databases_rust::setup_databases(&databases_config).layer(gatekeeper_auth_layer);

    // Every slice's routes, gated per slice, composed once: the routes each
    // listener serves. The listener-specific layers go on top of this, below.
    let inner_router = Router::new()
        .merge(gatekeeper.router)
        .merge(gated_fhir_r4)
        .merge(gated_ohif_server)
        .merge(gated_collector)
        .merge(gated_request_log)
        // `/health`: the draft-06 health report of the server's checks,
        // which the reachability monitor round-trips through the relay.
        // Ungated so the monitor (and any external uptime check) needs no
        // bearer token; the report says pass, warn or fail and nothing more.
        .merge(shared_structures_rust::health_check::health_router(
            Arc::new(health_checks),
        ))
        .merge(gated_apps)
        .merge(gated_databases)
        // No slice claimed the route: `404`, pointing a browser at the hosted
        // owner UI (the server serves no UI of its own). See `not_found.rs`.
        .fallback(not_found::fallback(Arc::new(not_found::NotFoundConfig {
            owner_ui_base,
            loopback_base_url: loopback_base_url.clone(),
        })));

    // Every forwarded request is reported to the request log once its response
    // is ready, and to the host unless it is a `/health` check (the
    // reachability monitor's probes).
    let forwarded_request_report = axum::middleware::from_fn_with_state(
        ForwardedRequestSenders {
            host_tx: observers.forwarded_request_tx,
            request_log_tx: request_log.forwarded_request_tx,
        },
        forwarded_request_layer::report_forwarded_request,
    );

    // The loopback listener's router: the inner router behind the loopback
    // owner trust, the loopback-peer gate, CORS and the forwarded-request
    // report, innermost first.
    let loopback_router = inner_router
        .clone()
        // Desktop loopback-owner trust (see `inject_loopback_owner_token`):
        // present the host owner token for a direct-local caller so the webview
        // authenticates on connection provenance. Inner of CORS (which answers
        // preflight first) and of the loopback-peer gate.
        .layer(axum::middleware::from_fn_with_state(
            LoopbackOwnerTrust {
                token_rx: host.host_owner_token_tx.subscribe(),
            },
            inject_loopback_owner_token,
        ))
        // Defense-in-depth: gate the whole surface on a loopback peer address.
        // Every request on this listener comes from this machine: directly, or
        // relayed by a front run on it, which proxies remote callers from
        // loopback (and is distinguished downstream by the `Forwarded` header).
        // A genuinely non-loopback peer is rejected with `403` before any
        // handler runs, so even a bearer-gated, CORS-permissive endpoint like
        // `POST /apps/{id}` (which can open a native popup on the owner's
        // device) can't be driven by a non-loopback client. See
        // `require_loopback_peer_middleware` for how forwarded callers pass and
        // why re-gating the gatekeeper's already-gated routes is harmless.
        .layer(require_loopback_peer_middleware())
        // The webview page is NOT served from this origin — it loads from
        // the Vite dev server (`http://localhost:1420`) in dev and Tauri's
        // asset protocol (`tauri://localhost`) in builds, while API fetches
        // target this server absolutely (the React tauri entry's
        // `apiBaseUrl`). So every API request is cross-origin and the API
        // must impose no CORS restriction beyond refusing credentials (see
        // `api_cors_layer`). Trust doesn't come from CORS here anyway: the
        // loopback gate rejects non-local peers and auth rides the bearer
        // header.
        .layer(api_cors_layer())
        // Outermost, so every response is reported as it leaves.
        .layer(forwarded_request_report.clone());

    // The tunnel listener's router: the inner router behind the
    // forwarded-request report, the tunnel front and CORS, innermost first. It
    // has no loopback owner trust and no loopback-peer gate: no tunnel
    // connection is a local caller, whatever its peer or headers.
    let tunnel_router = inner_router
        .layer(forwarded_request_report)
        // Hold the request to the server's public host and write its
        // `Forwarded` header (see `stamp_tunnel_forwarded`), so every layer
        // and handler inside reads it as a forwarded request, served at the
        // public origin. A misdirected request's `421` is not reported.
        .layer(axum::middleware::from_fn_with_state(
            TunnelFront::new(public_origin)?,
            stamp_tunnel_forwarded,
        ))
        // Outermost, so a remote app can read even the front's `421`: the
        // same CORS policy as the loopback listener, since a remote app's
        // fetches are cross-origin too and auth rides the bearer header. A
        // preflight is answered here, before the front, and isn't reported.
        .layer(api_cors_layer());

    Ok(WildflowerServer {
        loopback_listener,
        loopback_router,
        tunnel_listener: TunnelListener::new(tunnel_stream_rx),
        tunnel_router,
        #[cfg(feature = "test-support")]
        tunnel_stream_tx,
        tunnel_daemon,
        reachability_monitor,
    })
}

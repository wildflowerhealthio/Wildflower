pub mod bridge;
pub mod config;
// The modules below aren't part of the host contract (the Tauri host imports
// the crate-root re-exports plus `bridge`), but they stay `pub` because a web of
// cross-module intra-doc links references them: narrowing a link *target* to
// `pub(crate)` while a `pub` module's doc links into it fails
// `cargo doc -D warnings` (rustdoc's `private_intra_doc_links`). `seeding` has no
// inbound doc links, so it is the one narrowed to `pub(crate)`.
// The web Owner-session cookie builders — a package-level capability lifted out
// of `http`: the desktop host seeds these cookies into the native-webview popup
// (#256) and the forwarded self-hosted launch re-scopes them, neither of which
// is an HTTP-handler concern. See `docs/Apps/Explanation.md`.
pub mod cookies;
pub mod crypto_util;
pub mod db;
pub mod domain;
pub mod http;
// Host/HTTP-seam dependency-inversion traits the domain actions call out through
// (device-consent republish, session-token revoke, session-cookie clear); the
// concrete impls are wired onto `Arc<GatekeeperState>` in `http::state`. Mirrors
// apps-rust.
pub(crate) mod ports;
pub(crate) mod seeding;

pub(crate) mod adapters;

// The shared runtime state + per-resource capability bindings. At the crate root
// (not under `http`) so the `domain/` capabilities can be built from it without
// `domain/` depending on `crate::http`; the struct is axum-free (the one
// axum-touching seam impl lives in `http::state`).
pub(crate) mod live_bindings;

use std::sync::Arc;

use anyhow::Context;
use chrono::{Duration, Utc};
use scopes_rust::{
    ContextLevel, FhirResourceScope, KnownScope, Permission, ResourceType, Scope,
    WildflowerResourceScope, WildflowerResourceType,
};
use token_revocation_rust::RevocationStore;
use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};

pub use config::GatekeeperConfig;
pub use db::SqliteGatekeeperStore;
// Debug builds only: the OAuth clients for the first-party apps' vite dev servers
// (the gatekeeper half of `apps_rust::seed_dev_apps`). Gated so a release build
// contains no code that could write them.
#[cfg(debug_assertions)]
pub use seeding::seed_dev_app_clients;
// The persistence port traits, re-exported so out-of-crate callers (e.g. the
// integration test) can bring the store methods into scope on the concrete
// `SqliteGatekeeperStore` adapter. `GatekeeperStore` is the transaction seam
// (and carries the standalone-convenience default methods); `GatekeeperTx` is
// the primitive contract a composed transaction hands out.
pub use domain::pending_consent::PendingConsentHead;
pub use domain::{GatekeeperStore, GatekeeperTx};
// Re-exported so the host can name the pool type at the `setup_gatekeeper`
// call site without a direct diesel dependency; the canonical home is
// persistence-rust (collector re-exports it the same way).
pub use persistence_rust::DieselPool;
// The owner-session cookie builders keep their top-level path
// (`gatekeeper_rust::owner_session_cookies`) after the lift out of `http`, so
// the desktop host's call sites don't move.
pub use cookies::{owner_session_cookies, rescope_owner_session_set_cookies};
/// The admin scopes the `/access` surface enforces — the registry meant to
/// couple *enforced* (the scope-gated capability extractors) with *grantable*
/// (the vocabulary the consent surfaces will offer). Re-exported for the host
/// and the resource-authz epic's consent UI; nothing consumes it yet — its
/// tests pin the set until then. See [`domain::capabilities`].
pub use domain::capabilities::grantable_admin_scopes;
pub use http::{
    client_allowed_scopes, ensure_bearer_header, gatekeeper_auth_middleware,
    is_pre_auth_public_path, openapi_spec, require_loopback_peer_middleware,
    GatekeeperAuthMiddleware, GatekeeperState, RequireLoopbackPeerMiddleware,
};
// The self-hosted redirect seam: the host implements it (backed by the apps
// store) and passes it into `setup_gatekeeper`, so its trait + types are public.
pub use ports::{NoSelfHostedRedirects, SelfHostedRedirectResolver, SelfHostedRedirectTopology};

/// `client_id` of the host application's first-party OAuth client. The host
/// uses this identity to mint Owner tokens for itself and to recognise its
/// own client registration during bootstrap.
///
/// This is the standalone/test fallback: the live Tauri app sources the id from
/// `tauri-shared-config.json` and threads it via
/// [`GatekeeperConfig::first_party_client_id`], the single source shared with the
/// TS shell (`gatekeeper-core`'s `FIRST_PARTY_CLIENT_ID` is the matching TS
/// fallback), so the id can't drift across the boundary. Rendered by
/// [`default_first_party_client_id`].
pub const FIRST_PARTY_CLIENT_ID: &str = "wildflower-host";

/// The maximal-access scopes that mark an Owner: full system FHIR access
/// (`system/*.cruds`) **and** full Wildflower-resource access
/// (`wildflower/*.cruds`). An Owner token covers *every* one of these, so it
/// covers every per-resource `/access/*` scope the scope-gated extractors
/// require — the fail-closed owner default. (Replaced the bespoke
/// `wildflower/admin` scope.)
pub const WILDFLOWER_WIDEST_SCOPES: &[Scope] = &[
    Scope::FhirResource(FhirResourceScope {
        context: ContextLevel::System,
        resource: ResourceType::Wildcard,
        permission: Permission::ALL,
    }),
    Scope::WildflowerResource(WildflowerResourceScope {
        resource: WildflowerResourceType::Wildcard,
        permission: Permission::ALL,
    }),
];

/// The **default** scopes granted to the first-party host (`wildflower-host`):
/// the widest set, so local users can drive both the FHIR surface and the
/// non-FHIR (Wildflower) APIs. Rendered by [`default_local_granted_scopes`].
///
/// This is no longer the *live* source: the running Tauri app sources the host
/// grant from `tauri-shared-config.json` and threads it via
/// [`GatekeeperConfig::host_owner_scopes`], so the value can't drift from the TS
/// shell's device-authorization request. This const is the fallback for
/// standalone/test builds that don't thread one.
///
/// Spelled out independently of [`WILDFLOWER_WIDEST_SCOPES`] (the owner-defining
/// set) even though the FHIR + Wildflower wildcards coincide: the host's *grant*
/// and the *owner definition* are distinct concepts that diverge here — the grant
/// additionally carries `wildflower/launch`, an owner *capability* (not part of the
/// owner *identity* [`WILDFLOWER_WIDEST_SCOPES`]). As a *known* scope it is NOT
/// covered by the `wildflower/*` resource wildcard, so the apps launch surface
/// would `403` the owner without it granted explicitly here.
pub const WILDFLOWER_LOCAL_GRANTED_SCOPES: &[Scope] = &[
    Scope::FhirResource(FhirResourceScope {
        context: ContextLevel::System,
        resource: ResourceType::Wildcard,
        permission: Permission::ALL,
    }),
    Scope::WildflowerResource(WildflowerResourceScope {
        resource: WildflowerResourceType::Wildcard,
        permission: Permission::ALL,
    }),
    // The app-launch umbrella capability — granted, not part of the owner identity.
    Scope::Known(KnownScope::AnyScopedAppLaunch),
];

/// The default host granted-scope wire strings — the rendered
/// [`WILDFLOWER_LOCAL_GRANTED_SCOPES`]. Standalone and test builds seed
/// [`GatekeeperConfig::host_owner_scopes`] from this; the live Tauri app sources
/// the value from `tauri-shared-config.json` instead.
pub fn default_local_granted_scopes() -> Vec<String> {
    scopes_rust::render_scopes(WILDFLOWER_LOCAL_GRANTED_SCOPES)
}

/// The default first-party `client_id` — [`FIRST_PARTY_CLIENT_ID`]. Standalone
/// and test builds seed [`GatekeeperConfig::first_party_client_id`] from this;
/// the live Tauri app sources the value from `tauri-shared-config.json` instead.
#[must_use]
pub fn default_first_party_client_id() -> String {
    FIRST_PARTY_CLIENT_ID.to_string()
}

/// Lifetime of the host owner token minted at boot (and re-minted hourly). Kept
/// short — it is a full-access bearer (full FHIR + admin scope) — and refreshed
/// well inside its own TTL by [`spawn_owner_token_reminter`], so a leaked copy
/// is only replayable for at most this long, and is revocable like any token in
/// the meantime. Was 24h before #269.
const HOST_OWNER_TOKEN_TTL: Duration = Duration::hours(2);

/// How often the host owner token is re-minted and republished on the owner-token
/// `watch` channel. Comfortably inside [`HOST_OWNER_TOKEN_TTL`] so the webview's
/// session cookie is always refreshed to a live token before the previous one
/// expires (they overlap by at least an hour).
const OWNER_TOKEN_REMINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// How often the background sweep drops denylist rows whose token has already
/// expired (mirrors the refresh-token/device-code reaping cadence). The first
/// sweep runs at startup; thereafter daily. A revoked-then-expired `jti` is
/// rejected by expiry validation regardless, so this only reclaims space.
const REVOCATION_PURGE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// How often the background sweep reclaims gatekeeper rows past their retention
/// window (see [`domain::retention`]). Same cadence as
/// [`REVOCATION_PURGE_INTERVAL`], and far finer than the coarsest window it
/// enforces (90 days), so a row is never retained much longer than the policy
/// says.
const RETENTION_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// How often the background reaper re-runs the popup-head query so the
/// watch channel drops a row whose `expires_at` has passed without any
/// HTTP mutation arriving to trigger a republish. Picked well under the
/// 5-minute `DEVICE_AUTHORIZATION_TTL` so a freshly-expired head clears
/// within seconds; the query itself is a single indexed `LIMIT 1` and the
/// watch sender suppresses no-op publishes.
const DEVICE_CONSENT_REAPER_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Result of `setup_gatekeeper`: the public router that should be merged
/// into the app's root router and the shared `Arc<GatekeeperState>` needed to
/// gate emr-rust traffic.
pub struct Gatekeeper {
    pub router: axum::Router,
    pub state: Arc<GatekeeperState>,
}

/// Build the gatekeeper-rust HTTP surface over the host-owned diesel
/// connection `pool` (the same app-wide `persistence_rust::open_pool` pool the
/// collector rides). Runs idempotent bootstrap
/// (schema migrations, signing-key seed, first-party client seed), mints
/// the boot-time host owner token against `config.loopback_base_url`, and:
///
///  - publishes the host owner token on `local_owner_token_tx` so subscribers (e.g.
///    the `WebView` bridge listener) observe it the moment it exists;
///  - publishes the current head of the pending consent queue — device-code
///    and authorization-code requests share one FIFO slot — on
///    `active_pending_consent_tx`. The host-side bridge task
///    forwards this through `bridge:PendingConsentRequested` events and
///    focuses the desktop window on transitions to `Some`. Seeding at
///    boot means a request that was pending across an app restart still
///    drives the popup (the row survived in SQLite, the in-memory
///    `watch` value didn't);
///  - returns a `Router` whose routes are at `/.well-known/jwks.json`,
///    `/oauth/*`, and `/access/*` (authenticated bearer JWT + per-resource
///    scope gates via the `Scoped<…>` extractors) — the
///    slice owns its mount paths so the caller just `.merge()`s;
///  - returns the `Arc<GatekeeperState>` the caller passes to
///    [`gatekeeper_auth_middleware`] to gate emr-rust.
///
/// Token claims follow the canonical model — `iss` is the fixed
/// [`shared_structures_rust::CANONICAL_ISSUER`] and `aud` is the per-request
/// served origin (derived from
/// [`served_base_url_for`](crate::http::served_base_url_for)). See
/// `docs/Origins/Explanation.md`.
///
/// The whole surface is gated by the loopback middleware — non-loopback
/// peers receive 403 before any handler runs.
///
/// `revocation_store` is the shared token-revocation store the host builds once
/// on the shared database and threads into both this setup and emr-rust's HFS
/// adapter, so the auth gate and the FHIR server read one denylist/epoch store.
///
/// # Errors
///
/// Returns an error if opening and seeding the store fails, minting the
/// host owner token fails, or the `local_owner_token_tx` receiver has already
/// been dropped when publishing the token.
pub fn setup_gatekeeper(
    pool: DieselPool,
    revocation_store: RevocationStore,
    config: &GatekeeperConfig,
    local_owner_token_tx: &watch::Sender<Option<String>>,
    active_pending_consent_tx: watch::Sender<Option<PendingConsentHead>>,
    self_hosted_redirects: Arc<dyn ports::SelfHostedRedirectResolver>,
) -> anyhow::Result<Gatekeeper> {
    // The host owner token is minted from `host_owner_scopes` (the live app sources
    // these from `tauri-shared-config.json`), but the `/access/*` owner gate
    // still checks coverage of every `WILDFLOWER_WIDEST_SCOPES` entry. The JSON
    // must keep covering WIDEST or the Owner UI silently 401s, so fail loudly at
    // boot rather than at first `/access/*` call.
    let host_owner: Vec<Scope> = config
        .host_owner_scopes
        .iter()
        .map(|s| Scope::from(s.as_str()))
        .collect();
    assert!(
        WILDFLOWER_WIDEST_SCOPES
            .iter()
            .all(|widest| host_owner.iter().any(|held| held.covers(widest))),
        "host_owner_scopes (from tauri-shared-config.json) must cover every \
         WILDFLOWER_WIDEST_SCOPES entry, or the host owner token can't pass the \
         /access/* owner gate; got {:?}",
        config.host_owner_scopes
    );
    let store = seeding::open_and_seed_store(
        pool,
        &config.host_owner_scopes,
        &config.first_party_client_id,
    )?;
    // `iss` and `aud` are both the canonical issuer: the one token is presented
    // over loopback and at the tunnel origin (#256), so a served-origin `aud`
    // couldn't cover both. See `docs/Origins/Explanation.md`.
    let host_owner_token = seeding::mint_host_owner_token(
        &store,
        shared_structures_rust::CANONICAL_ISSUER,
        shared_structures_rust::CANONICAL_ISSUER,
        HOST_OWNER_TOKEN_TTL,
        &config.host_owner_scopes,
        &config.first_party_client_id,
    )
    .context("failed to mint host owner token")?;
    local_owner_token_tx
        .send(Some(host_owner_token))
        .context("token channel receiver dropped before host owner token issuance")?;
    let state = Arc::new(GatekeeperState {
        store: store.clone(),
        revocation_store: revocation_store.clone(),
        loopback_base_url: config.loopback_base_url.clone(),
        first_party_client_id: config.first_party_client_id.clone().into(),
        active_pending_consent_sender: active_pending_consent_tx,
        self_hosted_redirects,
    });
    // Seed the popup head from SQLite so a request that was pending
    // across an app restart still drives the modal on first webview
    // load — the `watch` value itself doesn't survive the process, but
    // the row does.
    ports::PendingConsentPublisher::republish_active(state.as_ref());
    spawn_device_consent_reaper(state.clone());
    // Reclaim gatekeeper rows past their retention window: once at startup, then
    // daily. Spawned before the re-minter, which consumes `store`.
    spawn_retention_sweep(store.clone());
    // Keep the webview's owner-session token fresh: re-mint + republish inside
    // the (now-short) owner-token TTL. See #269.
    spawn_owner_token_reminter(
        store,
        config.host_owner_scopes.clone(),
        config.first_party_client_id.clone(),
        local_owner_token_tx.clone(),
    );
    // Reclaim expired denylist rows: once at startup, then daily.
    spawn_revocation_purge(revocation_store);
    let router = http::router(state.clone());
    Ok(Gatekeeper { router, state })
}

/// Spawn the timer that re-mints the host owner token every
/// [`OWNER_TOKEN_REMINT_INTERVAL`] and republishes it on the owner-token
/// `watch` channel, so the webview's session cookie is refreshed to a live
/// token before the previous (short-lived, #269) one expires. On a mint failure
/// it logs and retries next tick; when every receiver has dropped (app
/// shutdown) it stops.
fn spawn_owner_token_reminter(
    store: SqliteGatekeeperStore,
    host_owner_scopes: Vec<String>,
    first_party_client_id: String,
    sender: watch::Sender<Option<String>>,
) {
    tokio::spawn(async move {
        let mut ticks = interval(OWNER_TOKEN_REMINT_INTERVAL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // The first tick fires immediately; the boot-time mint in
        // `setup_gatekeeper` already published a token, so consume it.
        ticks.tick().await;
        loop {
            ticks.tick().await;
            match seeding::mint_host_owner_token(
                &store,
                shared_structures_rust::CANONICAL_ISSUER,
                shared_structures_rust::CANONICAL_ISSUER,
                HOST_OWNER_TOKEN_TTL,
                &host_owner_scopes,
                &first_party_client_id,
            ) {
                // `send` errors only once every receiver has dropped — i.e. the
                // app is shutting down — so stop the timer then.
                Ok(token) => {
                    if sender.send(Some(token)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "owner-token re-mint failed; retrying next tick");
                }
            }
        }
    });
}

/// Spawn the background sweep that purges expired rows from the revocation
/// denylist — once at startup (the interval's immediate first tick) then every
/// [`REVOCATION_PURGE_INTERVAL`]. Purely space reclamation: an expired `jti` is
/// already rejected by expiry validation, denylisted or not.
fn spawn_revocation_purge(revocation_store: RevocationStore) {
    tokio::spawn(async move {
        let mut ticks = interval(REVOCATION_PURGE_INTERVAL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            // First tick is immediate → startup purge; then daily.
            ticks.tick().await;
            // Retention floor = the longest access token we mint (the 2h host
            // owner token dwarfs the 15-min OAuth `ACCESS_TOKEN_TTL`), so a
            // denylist row is never dropped while its token could still be live —
            // even if the `/access/revocations` caller supplied a too-early
            // `expiresAt`. See `RevocationStore::purge_expired`.
            match revocation_store.purge_expired(Utc::now(), HOST_OWNER_TOKEN_TTL) {
                Ok(purged) if purged > 0 => {
                    tracing::info!(purged, "swept expired revoked jtis");
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(%error, "revoked-jti sweep failed"),
            }
        }
    });
}

/// Spawn the background sweep that deletes gatekeeper rows past their retention
/// window — once at startup (the interval's immediate first tick), then every
/// [`RETENTION_SWEEP_INTERVAL`]. The windows and their rationale live in
/// [`domain::retention`].
///
/// Space reclamation only: every row it touches is already past `expires_at`
/// and rejected by the read paths, so nothing here changes what the server
/// honours. A failed sweep is logged and retried next tick.
///
/// Runs on [`spawn_blocking`](tokio::task::spawn_blocking) rather than a runtime
/// worker: `pool.get()` alone can park for r2d2's 30s connection timeout, and the
/// sweep then holds one write transaction across three unindexed full scans.
fn spawn_retention_sweep(store: SqliteGatekeeperStore) {
    tokio::spawn(async move {
        let mut ticks = interval(RETENTION_SWEEP_INTERVAL);
        // A long pause (suspend/resume) must not queue up catch-up sweeps —
        // one tick after the gap reclaims the same rows anyway.
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            // First tick is immediate → startup sweep; then daily.
            ticks.tick().await;
            // Cheap clone (the pool is an `Arc` inside) so the loop keeps its own
            // handle for the next tick.
            let sweep_store = store.clone();
            let swept = tokio::task::spawn_blocking(move || {
                domain::retention::purge_expired(&sweep_store, Utc::now())
            })
            .await;
            match swept {
                Ok(Ok(purged)) if !purged.is_empty() => tracing::info!(
                    refresh_token_families = purged.refresh_token_families,
                    authorization_requests = purged.authorization_requests,
                    authorization_codes = purged.authorization_codes,
                    "swept gatekeeper rows past their retention window",
                ),
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!(%error, "gatekeeper retention sweep failed"),
                Err(error) => tracing::warn!(%error, "gatekeeper retention sweep task failed"),
            }
        }
    });
}

/// Spawn the background reaper that periodically re-runs the popup-head
/// query. Mutation-driven republishing alone leaves the watch advertising
/// a `user_code` whose row has expired in the meantime — without this
/// task, an idle host stays stuck on the now-expired head until some
/// unrelated handler happens to write. The reaper drops the stale head
/// within `DEVICE_CONSENT_REAPER_INTERVAL`, and `send_if_modified`
/// suppresses ticks that leave the head unchanged so an idle queue
/// produces no bridge traffic.
fn spawn_device_consent_reaper(state: Arc<GatekeeperState>) {
    tokio::spawn(async move {
        let mut ticks = interval(DEVICE_CONSENT_REAPER_INTERVAL);
        // A long pause (suspend/resume, debugger break) must not cause a
        // burst of catch-up republishes — one tick after the gap is the
        // right behaviour.
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // The first tick fires immediately; the boot-time republish in
        // `setup_gatekeeper` already covered that, so consume it before
        // the loop.
        ticks.tick().await;
        loop {
            ticks.tick().await;
            ports::PendingConsentPublisher::republish_active(state.as_ref());
        }
    });
}

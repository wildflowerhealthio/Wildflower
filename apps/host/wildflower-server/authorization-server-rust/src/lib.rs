//! The Wildflower authorization server: the OAuth 2.0 and SMART App Launch
//! authorization server in front of the Owner's FHIR server. It decides which
//! apps, devices and browsers may reach the Owner's data, asks the Owner when
//! it must, and signs the access tokens the FHIR server checks.
//!
//! The host builds one with [`setup_authorization_server`] and merges its
//! router: `/oauth/*` for apps, devices and browsers on their way in,
//! `/authorization/*` for the Owner's own pages, and `/.well-known/jwks.json`
//! for anyone checking a token. `domain` holds the rules, `db` the `SQLite`
//! store, and `http` the routes that adapt between the two.
#![warn(missing_docs, clippy::missing_docs_in_private_items)]

pub mod config;
// The modules below aren't part of the host contract (the Tauri host imports
// the crate-root re-exports), but they stay `pub` because a web of
// cross-module intra-doc links references them: narrowing a link *target* to
// `pub(crate)` while a `pub` module's doc links into it fails
// `cargo doc -D warnings` (rustdoc's `private_intra_doc_links`). `seeding` has no
// inbound doc links, so it is the one narrowed to `pub(crate)`.
pub mod crypto_util;
pub mod db;
pub mod domain;
pub mod http;
// Host/HTTP-seam dependency-inversion traits the domain capabilities call out
// through (the Owner prompt's republish, token revocation, the start gate); the
// concrete impls live in `adapters`, on `AuthorizationServerState`. Mirrors
// apps-rust.
pub(crate) mod ports;
pub(crate) mod seeding;

pub(crate) mod adapters;

// The shared runtime state + per-resource capability bindings. At the crate root
// (not under `http`) so the `domain/` capabilities can be built from it without
// `domain/` depending on `crate::http`; the struct is axum-free (its port impls
// live in `adapters`, and `http::state` re-exports it).
pub(crate) mod live_bindings;

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};
use wildflowerhealthio_scopes::{
    ContextLevel, FhirResourceScope, Grant, KnownScope, Permission, ResourceType, Scope,
    WildflowerResourceScope, WildflowerResourceType,
};
use wildflowerhealthio_token_revocation::RevocationStore;

use crate::domain::browser_session::{StaleSessionCutoff, LONGEST_BROWSER_SESSION_TTL};
use crate::domain::last_seen_throttle::LastSeenThrottle;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::domain::sign_in_redirect::SignInDestinations;

pub use config::AuthorizationServerConfig;
pub use db::SqliteGrantStore;
// Debug builds only: the OAuth clients for the first-party apps' vite dev servers
// (the authorization server half of `wildflowerhealthio_apps::seed_dev_apps`). Gated so a release build
// contains no code that could write them.
#[cfg(debug_assertions)]
pub use seeding::seed_dev_app_clients;
// The persistence port, re-exported so out-of-crate callers (the host, the
// integration tests) can open a scope on the concrete `SqliteGrantStore`:
// `GrantStore` is the seam with its read and write scopes, `GrantTx` the
// bundle of per-table primitives a scope hands out (each concern's trait is
// in `domain::grant_store`).
pub use domain::consent_key::ConsentKey;
pub use domain::owner_prompt::OwnerPrompt;
pub use domain::{GrantStore, GrantTx};

/// The admin scopes the `/authorization` surface enforces — the registry meant to
/// couple *enforced* (the scope-gated capability extractors) with *grantable*
/// (the vocabulary a consent surface offers). Re-exported for the host;
/// nothing outside this crate consumes it, and its tests pin the set. See
/// `domain::capabilities`.
pub use domain::capabilities::grantable_admin_scopes;
pub use domain::same_device_sign_in_codes::SameDeviceSignInCode;
pub use http::{
    authorization_server_auth_middleware, browser_session_clearing_set_cookie,
    ensure_bearer_header, record_browser_session_cookie_use, standing_browser_session,
    AuthorizationServerAuthMiddleware, AuthorizationServerState, BROWSER_SESSION_COOKIE,
    BROWSER_SESSION_HEADER_VALUE, SESSION_HEADER,
};
pub use live_bindings::{
    InProcessTokenVerifier, LaunchContextMinter, PendingConsentWatcher, SameDeviceSignInCodeMinter,
};
// The host's say over how fast authorization requests are started (see
// `setup_authorization_server`).
pub use ports::{AdmitEveryAuthorizationStart, AuthorizationStartGate};
// Re-exported so the host can name the pool type at the `setup_authorization_server`
// call site without a direct diesel dependency; the canonical home is
// persistence-rust (apps and request-log re-export it the same way).
pub use wildflowerhealthio_persistence::DieselPool;

/// `client_id` of the Wildflower host app's OAuth client, seeded at bootstrap
/// with a server-defined registration. Like [`BROWSER_SESSION_CLIENT_ID`], it
/// is an essential client: it can't be disabled.
pub const WILDFLOWER_HOST_APP_CLIENT_ID: &str = "c4e755b6a4c1abf2aae6d0d83f2545a5";

/// `client_id` of the browser-session client: the browsers the server has
/// signed in. The Owner's is signed in by the host app on its own device with
/// a same-device sign-in code at `/oauth/sign-in`; any other browser pairs at
/// `/oauth/pair`, showing a code the Owner approves. Each such browser holds a
/// token issued to this client (its `sub`), so revoking the client's subject
/// signs every browser out, and one browser is signed out by revoking its
/// browser session (its token's `sid`) or its token's `jti`. Like
/// [`WILDFLOWER_HOST_APP_CLIENT_ID`], it is an essential client: it can't be
/// disabled. Seeded at boot by [`crate::setup_authorization_server`] with
/// [`OWNER_SCOPES`], the most a browser session may hold, and no grant type;
/// it takes part in no OAuth flow, since neither sign-in nor pairing is one.
pub const BROWSER_SESSION_CLIENT_ID: &str = "cb9bbe139845cae9654b7909d60d274f";

/// The maximal-access scopes that mark an Owner: full system FHIR access
/// (`system/*.cruds`) **and** full Wildflower-resource access
/// (`wildflower/*.cruds`). An Owner token covers *every* one of these, so it
/// covers every per-resource `/authorization/*` scope the scope-gated extractors
/// require — the fail-closed owner default.
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

/// The Owner's scopes: the authority the Owner approves consents with, what a
/// same-device session holds, the most a paired browser session may be granted,
/// and the browser-session client's `allowed_scopes`.
/// An approval can't delegate a resource scope these don't cover.
///
/// [`WILDFLOWER_WIDEST_SCOPES`] (the owner *identity*) plus `wildflower/launch`,
/// an owner *capability*. As a *known* scope it is NOT covered by the
/// `wildflower/*` resource wildcard, so the apps launch surface would `403` the
/// Owner without it listed explicitly here. Rendered by [`owner_scopes`].
pub const OWNER_SCOPES: &[Scope] = &[
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

/// The Owner's scope wire strings — the rendered [`OWNER_SCOPES`].
#[must_use]
pub fn owner_scopes() -> Vec<String> {
    wildflowerhealthio_scopes::render_scopes(OWNER_SCOPES)
}

/// The default scopes the host app's client may be granted: `openid` alone.
/// Standalone and test builds seed
/// [`AuthorizationServerConfig::host_app_client_scopes`] from this; the live
/// Tauri app sources the value from `tauri-shared-config.json` instead.
#[must_use]
pub fn default_host_app_client_scopes() -> Vec<String> {
    vec![Scope::Known(KnownScope::Openid).to_string()]
}

/// How often the background sweep drops denylist rows whose token has already
/// expired (mirrors the refresh-token/device-code reaping cadence). The first
/// sweep runs at startup; thereafter daily. A revoked-then-expired `jti` is
/// rejected by expiry validation regardless, so this only reclaims space.
const REVOCATION_PURGE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// How often the background sweep reclaims the authorization server rows past their retention
/// window (see [`domain::retention`]). Same cadence as
/// [`REVOCATION_PURGE_INTERVAL`], and far finer than the coarsest window it
/// enforces (90 days), so a row is never retained much longer than the policy
/// says.
const RETENTION_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// How often the background reaper recomputes the [`OwnerPrompt`], so the
/// watch channel drops a request whose `expires_at` has passed without any
/// HTTP mutation arriving to trigger a republish. Picked well under the
/// 5-minute `DEVICE_AUTHORIZATION_TTL` so a freshly-expired request clears
/// within seconds; the recompute is two `LIMIT 1` reads, one per request
/// table, and the watch sender suppresses no-op publishes.
const DEVICE_CONSENT_REAPER_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// What [`setup_authorization_server`] hands the host: the router to merge,
/// the shared state its own gates need, and the in-process handles it keeps.
pub struct AuthorizationServer {
    /// The server's HTTP surface, at `/.well-known/jwks.json`, `/oauth/*` and
    /// `/authorization/*`. The host merges it into its own router, which the
    /// tunnel listener serves.
    pub router: axum::Router,
    /// The shared state, which the host passes to
    /// [`authorization_server_auth_middleware`], the bearer gate on the FHIR
    /// server's routes.
    pub state: Arc<AuthorizationServerState>,
    /// Mints the SMART App Launch `launch` values `/oauth/authorize` consumes,
    /// which the in-process launchers (the apps slice, the host) put in an
    /// app's launch URL.
    pub launch_context_minter: LaunchContextMinter,
    /// Mints the one-time codes `/oauth/sign-in` signs the Owner's own browser
    /// in with: for the host, in-process. It also ends the sessions codes
    /// signed in, for the host to call once their views have closed.
    pub same_device_sign_in_code_minter: SameDeviceSignInCodeMinter,
    /// Waits for a pending consent to be decided or expire: for the host,
    /// in-process, which closes the page it opened the request at.
    pub pending_consent_watcher: PendingConsentWatcher,
    /// Verifies access tokens exactly as the authorization server's own gates
    /// do: for the host's FHIR server, which verifies each bearer through it
    /// in-process.
    pub in_process_token_verifier: InProcessTokenVerifier,
}

/// Build the authorization-server-rust HTTP surface over the host-owned diesel
/// connection `pool` (the same app-wide `wildflowerhealthio_persistence::open_pool` pool the
/// other diesel-backed slices ride). Runs idempotent bootstrap
/// (schema migrations, signing-key seed, essential-client seed), and:
///
///  - publishes the [`OwnerPrompt`], the newest request awaiting the Owner
///    (device-code and authorization-code requests and browser pairings
///    alike), on `owner_approval_tx`. On the
///    Tauri host, the server's run reports it as its detail, which the base's
///    server status carries and from which the host notifies each new
///    request.
///    Seeding at boot means a request that was pending
///    across an app restart is still reported (the row survived in SQLite, the
///    in-memory `watch` value didn't);
///  - cuts off, at the run's start, the same-device sessions earlier runs
///    signed in, except those `open_views_sign_in_codes` signed in: the codes
///    of the host's launch views still open, whichever run minted them. The
///    host ends a same-device session once the last of the server's launch
///    views has closed, so a session no open view holds is one whose ending
///    was missed, as across the app's exit, or failed. So the
///    `StaleSessionCutoff` invalidates sessions before the run's start,
///    with the open views' sessions exempt: it makes the others stale,
///    writing nothing, so a store that can't be written doesn't keep the
///    server from starting, and the browser is sent through sign-in again,
///    which the host's next launch does. Paired sessions stand;
///  - returns a `Router` whose routes are at `/.well-known/jwks.json`,
///    `/oauth/*`, and `/authorization/*` (authenticated bearer JWT + per-resource
///    scope gates via the `Scoped<…>` extractors) — the
///    slice owns its mount paths so the caller just `.merge()`s;
///  - returns the `Arc<AuthorizationServerState>` the caller passes to
///    [`authorization_server_auth_middleware`] to gate fhir-r4-rust;
///  - returns the [`LaunchContextMinter`] an in-process launcher mints each
///    SMART App Launch `launch` value through, which `/oauth/authorize` then
///    consumes;
///  - returns the [`SameDeviceSignInCodeMinter`] the host mints each
///    same-device sign-in code through, which `/oauth/sign-in` then redeems,
///    and which ends the sessions codes signed in when the host asks;
///  - returns the [`PendingConsentWatcher`] the host waits on for a pending
///    consent it opened to be decided or expire;
///  - returns the [`InProcessTokenVerifier`] the host's FHIR server verifies
///    each bearer through, in-process.
///
/// `authorization_start_gate` says whether a request may start an
/// authorization request (`GET /oauth/authorize`,
/// `POST /oauth/device_authorization`): asked for every one that carries no
/// live browser session, which is answered `429` when it refuses. Pass
/// [`AdmitEveryAuthorizationStart`] where no visitor reaches the server.
///
/// Every token this server mints carries the server's origin
/// ([`AuthorizationServerConfig::server_origin`]) as both `iss` and `aud`, and
/// the bearer gates accept no other. See
/// `docs/Origins/Explanation.md`.
///
/// `revocation_store` is the shared token-revocation store the host builds once
/// on the shared database and threads into both this setup and fhir-r4-rust's HFS
/// adapter, so the auth gate and the FHIR server read one denylist/epoch store.
///
/// # Errors
///
/// Returns an error if opening and seeding the store fails.
pub fn setup_authorization_server(
    pool: DieselPool,
    revocation_store: RevocationStore,
    config: &AuthorizationServerConfig,
    owner_approval_tx: watch::Sender<Option<OwnerPrompt>>,
    authorization_start_gate: Arc<dyn AuthorizationStartGate>,
    open_views_sign_in_codes: &[SameDeviceSignInCode],
) -> anyhow::Result<AuthorizationServer> {
    let store = seeding::open_and_seed_store(
        pool,
        &config.host_app_client_scopes,
        &config.fhir_ui_client_id,
        &config.server_origin,
    )?;
    let server_origin: Arc<str> =
        wildflowerhealthio_shared_structures::origin_string(&config.server_origin).into();
    let same_device_sign_in_codes = Arc::new(SameDeviceSignInCodes::new());
    let stale_session_cutoff = Arc::new(StaleSessionCutoff::new(
        Utc::now(),
        open_views_sign_in_codes
            .iter()
            .filter_map(SameDeviceSignInCode::signed_in_sid)
            .collect(),
    ));
    let (pending_consents_recomputed_tx, pending_consents_recomputed_rx) = watch::channel(());
    let state = Arc::new(AuthorizationServerState {
        store: store.clone(),
        revocation_store: revocation_store.clone(),
        server_origin: server_origin.clone(),
        device_page: Arc::new(http::device_page_url(&config.server_origin)),
        launcher_base: config.launcher_base.clone(),
        owner_approval_tx,
        pending_consents_recomputed_tx,
        owner_grant: Grant::new(OWNER_SCOPES.to_vec()),
        same_device_sign_in_codes: same_device_sign_in_codes.clone(),
        sign_in_destinations: Arc::new(SignInDestinations::new(
            config.server_origin.clone(),
            config.launcher_base.clone(),
            config.authorization_app_base.clone(),
            config.launcher_url.clone(),
            config.authorization_url.clone(),
        )),
        authorization_start_gate,
        last_seen_throttle: Arc::new(LastSeenThrottle::new()),
        stale_session_cutoff,
    });
    // Publish the Owner prompt from SQLite so a request that was
    // pending across an app restart is reported in the run's first detail —
    // the `watch` value itself doesn't survive the process, but the row
    // does.
    ports::OwnerApproval::republish_active(state.as_ref());
    spawn_device_consent_reaper(state.clone());
    // Reclaim the authorization server rows past their retention window: once at startup, then
    // daily.
    spawn_retention_sweep(store);
    // Reclaim expired denylist rows: once at startup, then daily.
    spawn_revocation_purge(revocation_store);
    let router = http::router(state.clone());
    let launch_context_minter = LaunchContextMinter::new(state.store.clone());
    let in_process_token_verifier = InProcessTokenVerifier::new(&state);
    let same_device_sign_in_code_minter =
        SameDeviceSignInCodeMinter::new(same_device_sign_in_codes, state.store.clone());
    let pending_consent_watcher =
        PendingConsentWatcher::new(state.store.clone(), pending_consents_recomputed_rx);
    Ok(AuthorizationServer {
        router,
        state,
        launch_context_minter,
        same_device_sign_in_code_minter,
        pending_consent_watcher,
        in_process_token_verifier,
    })
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
            // Retention floor = the longest access token we mint (a browser
            // session's token lives as long as the session, at most a day,
            // past the 15-min OAuth `ACCESS_TOKEN_TTL`), so a denylist row is
            // never dropped while its token could still be live — even if the
            // `/authorization/revocations` caller supplied a too-early
            // `expiresAt`. See `RevocationStore::purge_expired`.
            match revocation_store.purge_expired(Utc::now(), LONGEST_BROWSER_SESSION_TTL) {
                Ok(purged) if purged > 0 => {
                    tracing::info!(purged, "swept expired revoked jtis");
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(%error, "revoked-jti sweep failed"),
            }
        }
    });
}

/// Spawn the background sweep that deletes the authorization server rows past their retention
/// window — once at startup (the interval's immediate first tick), then every
/// [`RETENTION_SWEEP_INTERVAL`]. The windows and their rationale live in
/// [`domain::retention`].
///
/// Space reclamation only: every row it touches is already past `expires_at`
/// (or, for a browser session, its `revoked_at`) and rejected by the read
/// paths, so nothing here changes what the server honours. A failed sweep is
/// logged and retried next tick.
///
/// Runs on [`spawn_blocking`](tokio::task::spawn_blocking) rather than a runtime
/// worker: `pool.get()` alone can park for r2d2's 30s connection timeout, and the
/// sweep then holds one write transaction across a delete per table.
fn spawn_retention_sweep(store: SqliteGrantStore) {
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
                    code_authorization_requests = purged.code_authorization_requests,
                    user_code_requests = purged.user_code_requests,
                    authorization_codes = purged.authorization_codes,
                    browser_sessions = purged.browser_sessions,
                    "swept the authorization server rows past their retention window",
                ),
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    tracing::warn!(%error, "the authorization server retention sweep failed")
                }
                Err(error) => {
                    tracing::warn!(%error, "the authorization server retention sweep task failed")
                }
            }
        }
    });
}

/// Spawn the background reaper that periodically recomputes the
/// [`OwnerPrompt`]. Mutation-driven republishing alone leaves
/// the watch advertising a request whose row has expired in the meantime —
/// without this task, an idle host stays stuck on the now-expired request
/// until some unrelated handler happens to write. The reaper drops the stale
/// request within `DEVICE_CONSENT_REAPER_INTERVAL`, and `send_if_modified`
/// suppresses ticks that leave it unchanged so an idle server
/// publishes nothing.
fn spawn_device_consent_reaper(state: Arc<AuthorizationServerState>) {
    tokio::spawn(async move {
        let mut ticks = interval(DEVICE_CONSENT_REAPER_INTERVAL);
        // A long pause (suspend/resume, debugger break) must not cause a
        // burst of catch-up republishes — one tick after the gap is the
        // right behaviour.
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // The first tick fires immediately; the boot-time republish in
        // `setup_authorization_server` already covered that, so consume it before
        // the loop.
        ticks.tick().await;
        loop {
            ticks.tick().await;
            ports::OwnerApproval::republish_active(state.as_ref());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Owner's scopes cover every owner-defining scope, so an Owner's
    /// token passes every `/authorization/*` owner gate.
    #[test]
    fn the_owner_s_scopes_cover_the_widest_scopes() {
        assert!(Grant::new(OWNER_SCOPES.to_vec()).covers_all(WILDFLOWER_WIDEST_SCOPES));
    }
}

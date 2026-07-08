pub mod bridge;
pub mod config;
// The modules below aren't part of the host contract (the Tauri host imports
// the crate-root re-exports plus `bridge`), but they stay `pub` because a web of
// cross-module intra-doc links references them: narrowing a link *target* to
// `pub(crate)` while a `pub` module's doc links into it fails
// `cargo doc -D warnings` (rustdoc's `private_intra_doc_links`). `seeding` has no
// inbound doc links, so it is the one narrowed to `pub(crate)`.
pub mod crypto_util;
pub mod db;
pub mod domain;
pub mod http;
pub(crate) mod seeding;

use anyhow::Context;
use chrono::Duration;
use scopes_rust::{
    ContextLevel, FhirResourceScope, Permission, ResourceType, Scope, WildflowerResourceScope,
    WildflowerResourceType,
};
use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};

pub use config::GatekeeperConfig;
pub use db::GatekeeperStore;
pub use http::{
    ensure_bearer_header, is_pre_auth_public_path, layer_router_with_gatekeeper_auth_gating,
    layer_router_with_loopback_peer_gating, owner_session_cookies,
    rescope_owner_session_set_cookies, verify_owner_bearer, AppState,
};

/// `client_id` of the host application's first-party OAuth client. The host
/// uses this identity to mint Owner tokens for itself and to recognise its
/// own client registration during bootstrap.
pub const FIRST_PARTY_CLIENT_ID: &str = "wildflower-host";

/// The maximal-access scopes that mark an Owner: full system FHIR access
/// (`system/*.cruds`) **and** full Wildflower-resource access
/// (`wildflower/*.cruds`). `require_owner_auth` treats a token as Owner iff it
/// covers *every* one of these, gating the `/access/*` admin surface. (Replaced
/// the bespoke `wildflower/admin` scope.)
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
/// [`GatekeeperConfig::granted_scopes`], so the value can't drift from the TS
/// shell's device-authorization request. This const is the fallback for
/// standalone/test builds that don't thread one.
///
/// Spelled out independently of [`WILDFLOWER_WIDEST_SCOPES`] (the owner-defining
/// set) even though the two currently coincide: the host's *grant* and the
/// *owner definition* are distinct concepts that may diverge — e.g. the host
/// could later be granted `offline_access` without that scope widening the
/// `/access/*` owner gate.
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
];

/// The default host granted-scope wire strings — the rendered
/// [`WILDFLOWER_LOCAL_GRANTED_SCOPES`]. Standalone and test builds seed
/// [`GatekeeperConfig::granted_scopes`] from this; the live Tauri app sources
/// the value from `tauri-shared-config.json` instead.
pub fn default_local_granted_scopes() -> Vec<String> {
    scopes_rust::render_scopes(WILDFLOWER_LOCAL_GRANTED_SCOPES)
}

/// Lifetime of the host owner token minted at boot.
const HOST_OWNER_TOKEN_TTL: Duration = Duration::hours(24);

/// How often the background reaper re-runs the popup-head query so the
/// watch channel drops a row whose `expires_at` has passed without any
/// HTTP mutation arriving to trigger a republish. Picked well under the
/// 5-minute `DEVICE_AUTHORIZATION_TTL` so a freshly-expired head clears
/// within seconds; the query itself is a single indexed `LIMIT 1` and the
/// watch sender suppresses no-op publishes.
const DEVICE_CONSENT_REAPER_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Result of `setup_gatekeeper`: the public router that should be merged
/// into the app's root router and the shared `AppState` needed to gate
/// emr-rust traffic.
pub struct Gatekeeper {
    pub router: axum::Router,
    pub state: AppState,
}

/// Build the gatekeeper-rust HTTP surface. Runs idempotent bootstrap
/// (schema migrations, signing-key seed, first-party client seed), mints
/// the boot-time host owner token against `config.loopback_base_url`, and:
///
///  - publishes the host owner token on `local_owner_token_tx` so subscribers (e.g.
///    the `WebView` bridge listener) observe it the moment it exists;
///  - publishes the current head of the pending device-code consent
///    queue on `active_device_user_code_tx`. The host-side bridge task
///    forwards this through `bridge:DeviceConsentRequested` events and
///    focuses the desktop window on transitions to `Some`. Seeding at
///    boot means a request that was pending across an app restart still
///    drives the popup (the row survived in SQLite, the in-memory
///    `watch` value didn't);
///  - returns a `Router` whose routes are at `/.well-known/jwks.json`,
///    `/oauth/*`, and `/access/*` (Owner-only via bearer JWT) — the
///    slice owns its mount paths so the caller just `.merge()`s;
///  - returns the `AppState` the caller passes to
///    [`layer_router_with_gatekeeper_auth_gating`] to wrap emr-rust.
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
/// # Errors
///
/// Returns an error if opening and seeding the store fails, minting the
/// host owner token fails, or the `local_owner_token_tx` receiver has already
/// been dropped when publishing the token.
pub fn setup_gatekeeper(
    conn: persistence_rust::Connection,
    config: &GatekeeperConfig,
    local_owner_token_tx: &watch::Sender<Option<String>>,
    active_device_user_code_tx: watch::Sender<Option<String>>,
) -> anyhow::Result<Gatekeeper> {
    // The host owner token is minted from `granted_scopes` (the live app sources
    // these from `tauri-shared-config.json`), but the `/access/*` owner gate
    // still checks coverage of every `WILDFLOWER_WIDEST_SCOPES` entry. The JSON
    // must keep covering WIDEST or the Owner UI silently 401s, so fail loudly at
    // boot rather than at first `/access/*` call.
    let granted: Vec<Scope> = config
        .granted_scopes
        .iter()
        .map(|s| Scope::from(s.as_str()))
        .collect();
    assert!(
        WILDFLOWER_WIDEST_SCOPES
            .iter()
            .all(|widest| granted.iter().any(|g| g.covers(widest))),
        "granted_scopes (from tauri-shared-config.json) must cover every \
         WILDFLOWER_WIDEST_SCOPES entry, or the host owner token can't pass the \
         /access/* owner gate; got {:?}",
        config.granted_scopes
    );
    let store = seeding::open_and_seed_store(conn, &config.granted_scopes)?;
    // `iss` and `aud` are both the canonical issuer: the one token is presented
    // over loopback and at the tunnel origin (#256), so a served-origin `aud`
    // couldn't cover both. See `docs/Origins/Explanation.md`.
    let host_owner_token = seeding::mint_host_owner_token(
        &store,
        shared_structures_rust::CANONICAL_ISSUER,
        shared_structures_rust::CANONICAL_ISSUER,
        HOST_OWNER_TOKEN_TTL,
        &config.granted_scopes,
    )
    .context("failed to mint host owner token")?;
    local_owner_token_tx
        .send(Some(host_owner_token))
        .context("token channel receiver dropped before host owner token issuance")?;
    let state = AppState {
        store: store.clone(),
        loopback_base_url: config.loopback_base_url.clone(),
        active_device_user_code_sender: active_device_user_code_tx,
    };
    // Seed the popup head from SQLite so a request that was pending
    // across an app restart still drives the modal on first webview
    // load — the `watch` value itself doesn't survive the process, but
    // the row does.
    state.republish_active_device_user_code();
    spawn_device_consent_reaper(state.clone());
    let router = http::router(state.clone());
    Ok(Gatekeeper { router, state })
}

/// Spawn the background reaper that periodically re-runs the popup-head
/// query. Mutation-driven republishing alone leaves the watch advertising
/// a `user_code` whose row has expired in the meantime — without this
/// task, an idle host stays stuck on the now-expired head until some
/// unrelated handler happens to write. The reaper drops the stale head
/// within `DEVICE_CONSENT_REAPER_INTERVAL`, and `send_if_modified`
/// suppresses ticks that leave the head unchanged so an idle queue
/// produces no bridge traffic.
fn spawn_device_consent_reaper(state: AppState) {
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
            state.republish_active_device_user_code();
        }
    });
}

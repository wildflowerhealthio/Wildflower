pub mod bridge;
pub mod config;
// NOTE: the modules below are NOT part of the host contract — the only
// external consumer (the Tauri host) imports the curated crate-root
// re-exports plus `bridge`. They would ideally all be `pub(crate)`, but a
// web of module-level intra-doc links keeps most of them public:
//
//   * `crypto_util` (pub): tests/integration.rs reaches into
//     `crypto_util::oauth_user_code::is_valid_oauth_user_code`, and its
//     doc links to `[crate::domain::token]`.
//   * `domain` (pub): its doc links to `[crate::db]` and `[crate::http]`.
//   * `db` (pub): its docs link to `[crate::domain]`.
//
// Making any link *target* `pub(crate)` while a `pub` module's doc links
// into it turns rustdoc's `private_intra_doc_links` warning on (and fails
// `cargo doc -D warnings`). Narrowing these further means rephrasing those
// doc links in crypto_util/mod.rs, domain/mod.rs and db/mod.rs — all outside
// this change's file boundary.
//   * `http` (pub): `domain`'s doc links to `[crate::http]`.
//
// Flagged for the orchestrator. `seeding` carries no inbound pub doc
// links, so it is the one module narrowed here.
pub mod crypto_util;
pub mod db;
pub mod domain;
pub mod http;
pub(crate) mod seeding;

use anyhow::Context;
use chrono::Duration;
use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};

pub use config::GatekeeperConfig;
pub use db::GatekeeperStore;
pub use http::{
    layer_router_with_gatekeeper_auth_gating, layer_router_with_loopback_peer_gating, AppState,
};

/// `client_id` of the host application's first-party OAuth client. The host
/// uses this identity to mint Owner tokens for itself and to recognise its
/// own client registration during bootstrap.
pub const FIRST_PARTY_CLIENT_ID: &str = "wildflower-host";

/// OAuth scope that grants Owner-level access to the gatekeeper's
/// `/access/*` admin surface (client management, grant revocation, owner
/// consent endpoints). **Not** a SMART v2 scope and not parseable by
/// helios-auth's scope policy — `require_auth` does an exact-string match
/// against this constant. Pairing it with [`FULL_FHIR_ACCESS_SCOPE`] in
/// the owner token gives the host both admin and FHIR access without
/// overloading either scope's meaning.
pub const OWNER_SCOPE: &str = "wildflower/admin";

/// SMART v2 wildcard meaning "create / read / update / delete / search on
/// every resource type at the system access level". HFS's helios-auth scope
/// policy parses this and grants every FHIR operation. Granted alongside
/// [`OWNER_SCOPE`] in the boot owner token so the WebView's loopback FHIR
/// calls pass HFS's per-operation scope check.
pub const FULL_FHIR_ACCESS_SCOPE: &str = "system/*.cruds";

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
/// the boot-time host owner token against `config.loopback_origin`, and:
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
/// Every minted token's `iss` is
/// [`shared_structures_rust::CANONICAL_ISSUER`] — the same string HFS
/// validates against, so any token (boot owner token or per-request OAuth
/// token) passes HFS auth regardless of which transport it arrived over.
/// Per-request `aud` is still derived from
/// [`served_origin_for`](crate::http::served_origin_for) — useful for
/// SMART clients that match `aud` to the FHIR base URL they discovered.
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
    let store = seeding::open_and_seed_store(conn)?;
    let host_owner_token = seeding::mint_host_owner_token(
        &store,
        shared_structures_rust::CANONICAL_ISSUER,
        &config.loopback_origin,
        HOST_OWNER_TOKEN_TTL,
    )
    .context("failed to mint host owner token")?;
    local_owner_token_tx
        .send(Some(host_owner_token))
        .context("token channel receiver dropped before host owner token issuance")?;
    let state = AppState {
        store: store.clone(),
        loopback_origin: config.loopback_origin.clone(),
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

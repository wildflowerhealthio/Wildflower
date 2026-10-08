//! The shared gatekeeper runtime state — the router state every handler is built
//! over, and the composition point that wires the concrete adapters
//! ([`SqliteGatekeeperStore`], [`RevocationStore`]) to the domain ports. It lives
//! at the crate root (not under [`crate::http`]) deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it,
//! and `domain/` must not depend on `crate::http`. The struct itself is
//! axum-free.
//!
//! The port trait impls that adapt this state to the domain seams live in
//! [`crate::adapters`], and the bindings that name the concrete
//! `SqliteGatekeeperStore` live in the sibling [`crate::live_bindings`]
//! modules — so the generic, store-agnostic capabilities in `domain/` never
//! mention a concrete adapter.

use std::sync::Arc;

use tokio::sync::watch;

use shared_structures_rust::owner_ui::OwnerUiBase;
use token_revocation_rust::RevocationStore;

use crate::db::SqliteGatekeeperStore;
use crate::domain::pending_consent::PendingConsentHead;

/// Shared state threaded through every gatekeeper handler and lifted into the
/// scope-gated capabilities. Opaque to callers outside the crate — the host
/// receives one (inside an [`Arc`]) from [`crate::setup_gatekeeper`] and passes
/// it back into [`crate::gatekeeper_auth_middleware`] without
/// looking inside.
pub struct GatekeeperState {
    /// The **concrete** `SQLite` adapter (not `Arc<dyn GatekeeperStore>` or a
    /// generic): the store port is generic (`&impl GatekeeperStore`), and the
    /// capabilities are generic over it, so the router state and axum wiring stay
    /// monomorphic — per the collector/tunnel pattern.
    pub(crate) store: SqliteGatekeeperStore,
    /// The shared token-revocation store. The auth gate (through the
    /// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier))
    /// runs the full `is_revoked` check (denylist + subject epoch) through it,
    /// and the revoke control surface (logout, `/access/revocations`, grant
    /// revoke) writes to it through the [`Revocation`](crate::ports::Revocation)
    /// port. Cheap to clone — it wraps the same shared connection every other
    /// slice holds. The host builds one and threads it into both
    /// [`crate::setup_gatekeeper`] and emr-rust's HFS adapter, so the two
    /// enforcement points read one store.
    pub(crate) revocation_store: RevocationStore,
    /// The loopback base URL (e.g. `http://127.0.0.1:8080/`), pinned from
    /// [`GatekeeperConfig`](crate::GatekeeperConfig) at
    /// [`crate::setup_gatekeeper`]. Handlers don't read it directly: it is only
    /// the loopback fallback passed to
    /// [`served_base_url_for`](shared_structures_rust::served_origin::served_base_url_for), which resolves
    /// each request's served base URL for the owner UI links it renders. See
    /// `docs/Origins/Explanation.md`.
    pub(crate) loopback_base_url: url::Url,
    /// The server's bare origin (`https://<domain>`), reduced once from
    /// [`GatekeeperConfig::server_origin`](crate::GatekeeperConfig::server_origin)
    /// at [`crate::setup_gatekeeper`]: the `iss` and `aud` of every token this
    /// server mints, and the only ones its
    /// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier)
    /// accepts. An `Arc<str>` so each capability built from the state shares it.
    pub(crate) server_origin: Arc<str>,
    /// The host's first-party `client_id`, pinned from
    /// [`GatekeeperConfig`](crate::GatekeeperConfig) at
    /// [`crate::setup_gatekeeper`] — the same id [`crate::seeding`] seeds the
    /// first-party client row under (both sourced from `tauri-shared-config.json`
    /// on the live app). `/token` matches a request's presented `client_id`
    /// against it to grant first-party treatment. An `Arc<str>` so the string is
    /// shared rather than reallocated when the state is cloned before the `Arc`
    /// wrap.
    pub(crate) first_party_client_id: Arc<str>,
    /// The hosted owner UI [`page_paths`](crate::domain::page_paths) resolves the
    /// browser-facing pages on, pinned from
    /// [`GatekeeperConfig`](crate::GatekeeperConfig) at [`crate::setup_gatekeeper`].
    pub(crate) owner_ui_base: OwnerUiBase,
    /// Watch sender publishing the [`PendingConsentHead`] the host webview
    /// surfaces in its popup. Handlers whose write may change the head call the
    /// [`PendingConsentPublisher::republish_active`](crate::ports::PendingConsentPublisher::republish_active)
    /// seam after the write completes.
    pub(crate) active_pending_consent_tx: watch::Sender<Option<PendingConsentHead>>,
    /// The host's native loopback dialog (see
    /// [`LoopbackConsentPrompt`](crate::ports::LoopbackConsentPrompt)):
    /// `/authorize` puts a direct-loopback login by the hosted owner UI to it. A
    /// host with no native dialog (and tests) wires
    /// [`NoLoopbackConsentPrompt`](crate::ports::NoLoopbackConsentPrompt), which
    /// abstains, leaving every such login to the Owner UI.
    pub(crate) loopback_consent_prompt: Arc<dyn crate::ports::LoopbackConsentPrompt>,
    /// The host Owner's grant, parsed from
    /// [`GatekeeperConfig::host_owner_scopes`](crate::GatekeeperConfig::host_owner_scopes)
    /// — the approving authority when the Owner answers the loopback dialog,
    /// the same scopes the host owner token carries.
    pub(crate) host_owner_grant: scopes_rust::Grant,
}

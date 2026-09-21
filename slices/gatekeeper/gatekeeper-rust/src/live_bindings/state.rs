//! The shared gatekeeper runtime state — the router state every handler is built
//! over, and the composition point that wires the concrete adapters
//! ([`SqliteGatekeeperStore`], [`RevocationStore`]) to the domain ports. It lives
//! at the crate root (not under [`crate::http`]) deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it,
//! and `domain/` must not depend on `crate::http`. The struct itself is
//! axum-free; the one axum-touching seam impl (`SessionCookies`, which takes a
//! `HeaderMap`) stays in [`crate::http`].
//!
//! The port trait impls that adapt this state to the domain seams live in sibling
//! files ([`PendingConsentPublisher`](crate::adapters::pending_consent_publisher),
//! [`Revocation`](crate::adapters::revocation_store)), and the per-resource
//! `FixedScopeCapability`/`Capability` bindings that name the concrete
//! `SqliteGatekeeperStore` live in [`grants`](super::grants),
//! [`consents`](super::consents), and [`tokens`](super::tokens) — so the generic,
//! store-agnostic capabilities in `domain/` never mention a concrete adapter.

use std::sync::Arc;

use tokio::sync::watch;

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
    /// The shared token-revocation store. The auth gate
    /// ([`verify_auth_token_claims`](crate::http::middleware::require_auth::verify_auth_token_claims))
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
    /// [`served_base_url_for`](crate::http::served_base_url_for), which resolves
    /// each request's served base URL (and hence its token `aud`). See
    /// `docs/Origins/Explanation.md`.
    pub(crate) loopback_base_url: url::Url,
    /// The host's first-party `client_id`, pinned from
    /// [`GatekeeperConfig`](crate::GatekeeperConfig) at
    /// [`crate::setup_gatekeeper`] — the same id [`crate::seeding`] seeds the
    /// first-party client row under (both sourced from `tauri-shared-config.json`
    /// on the live app). `/token` matches a request's presented `client_id`
    /// against it to grant first-party treatment. An `Arc<str>` so the string is
    /// shared rather than reallocated when the state is cloned before the `Arc`
    /// wrap.
    pub(crate) first_party_client_id: Arc<str>,
    /// Watch sender publishing the [`PendingConsentHead`] the host webview
    /// surfaces in its popup. Handlers whose write may change the head call the
    /// [`PendingConsentPublisher::republish_active`](crate::ports::PendingConsentPublisher::republish_active)
    /// seam after the write completes.
    pub(crate) active_pending_consent_sender: watch::Sender<Option<PendingConsentHead>>,
    /// Resolves a `client_id` to a self-hosted app's redirect topology so
    /// `/authorize` can expand an app-relative `redirect_uri` entry against the
    /// request's provenance (see
    /// [`SelfHostedRedirectResolver`](crate::ports::SelfHostedRedirectResolver)).
    /// The host wires the apps-store-backed impl; a host with no self-hosted apps
    /// (and tests) wires the no-op, so relative entries simply never match.
    pub(crate) self_hosted_redirects: Arc<dyn crate::ports::SelfHostedRedirectResolver>,
}

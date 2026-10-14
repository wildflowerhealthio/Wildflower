//! The shared authorization server runtime state — the router state every handler is built
//! over, and the composition point that wires the concrete adapters
//! ([`SqliteGrantStore`], [`RevocationStore`]) to the domain ports. It lives
//! at the crate root (not under [`crate::http`]) deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it,
//! and `domain/` must not depend on `crate::http`. The struct itself is
//! axum-free.
//!
//! The port trait impls that adapt this state to the domain seams live in
//! [`crate::adapters`], and the bindings that name the concrete
//! `SqliteGrantStore` live in the sibling [`crate::live_bindings`]
//! modules — so the generic, store-agnostic capabilities in `domain/` never
//! mention a concrete adapter.

use std::sync::Arc;

use tokio::sync::watch;

use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_token_revocation::RevocationStore;

use crate::db::SqliteGrantStore;
use crate::domain::host_app_client_lock::{HostAppClientLock, HostAppLockedRevocation};
use crate::domain::pending_consent::PendingConsentHead;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::domain::sign_in_redirect::SignInDestinations;
use crate::ports::Revocation;

/// Shared state threaded through every authorization server handler and lifted into the
/// scope-gated capabilities. Opaque to callers outside the crate — the host
/// receives one (inside an [`Arc`]) from [`crate::setup_authorization_server`] and passes
/// it back into [`crate::authorization_server_auth_middleware`] without
/// looking inside.
pub struct AuthorizationServerState {
    /// The **concrete** `SQLite` adapter (not `Arc<dyn GrantStore>` or a
    /// generic): the store port is generic (`&impl GrantStore`), and the
    /// capabilities are generic over it, so the router state and axum wiring stay
    /// monomorphic — as in the apps and request-log slices.
    pub(crate) store: SqliteGrantStore,
    /// The shared token-revocation store. The auth gate (through the
    /// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier))
    /// runs the full `is_revoked` check (denylist + subject epoch) through it,
    /// and the revoke control surface (logout, `/authorization/revocations`, grant
    /// revoke) writes to it through the [`Revocation`](crate::ports::Revocation)
    /// port. Cheap to clone — it wraps the same shared connection every other
    /// slice holds. The host builds one and threads it into both
    /// [`crate::setup_authorization_server`] and fhir-r4-rust's HFS adapter, so the two
    /// enforcement points read one store.
    pub(crate) revocation_store: RevocationStore,
    /// The loopback base URL (e.g. `http://127.0.0.1:8080/`), pinned from
    /// [`AuthorizationServerConfig`](crate::AuthorizationServerConfig) at
    /// [`crate::setup_authorization_server`]. Handlers don't read it directly: it is only
    /// the loopback fallback passed to
    /// [`served_base_url_for`](wildflowerhealthio_shared_structures::served_origin::served_base_url_for), which resolves
    /// each request's served base URL for the launcher links it renders. See
    /// `docs/Origins/Explanation.md`.
    pub(crate) loopback_base_url: url::Url,
    /// The server's bare origin (`https://<domain>`), reduced once from
    /// [`AuthorizationServerConfig::server_origin`](crate::AuthorizationServerConfig::server_origin)
    /// at [`crate::setup_authorization_server`]: the `iss` and `aud` of every token this
    /// server mints, and the only ones its
    /// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier)
    /// accepts. An `Arc<str>` so each capability built from the state shares it.
    pub(crate) server_origin: Arc<str>,
    /// The Wildflower host app's `client_id`, pinned from
    /// [`AuthorizationServerConfig`](crate::AuthorizationServerConfig) at
    /// [`crate::setup_authorization_server`] — the same id [`crate::seeding`] seeds the
    /// host app's client row under (both sourced from `tauri-shared-config.json`
    /// on the live app). `/token` matches a request's presented `client_id`
    /// against it to grant first-party treatment. An `Arc<str>` so the string is
    /// shared rather than reallocated when the state is cloned before the `Arc`
    /// wrap.
    pub(crate) wildflower_host_app_client_id: Arc<str>,
    /// The hosted launcher [`page_paths`](crate::domain::page_paths) resolves the
    /// browser-facing pages on, pinned from
    /// [`AuthorizationServerConfig`](crate::AuthorizationServerConfig) at [`crate::setup_authorization_server`].
    pub(crate) launcher_base: LauncherBase,
    /// Watch sender publishing the [`PendingConsentHead`] the host webview
    /// surfaces in its popup. Handlers whose write may change the head call the
    /// [`OwnerApproval::republish_active`](crate::ports::OwnerApproval::republish_active)
    /// seam after the write completes.
    pub(crate) owner_approval_tx: watch::Sender<Option<PendingConsentHead>>,
    /// The host's native loopback dialog (see
    /// [`LoopbackConsentPrompt`](crate::ports::LoopbackConsentPrompt)):
    /// `/authorize` puts a direct-loopback login by the hosted launcher to it. A
    /// host with no native dialog (and tests) wires
    /// [`NoLoopbackConsentPrompt`](crate::ports::NoLoopbackConsentPrompt), which
    /// abstains, leaving every such login to the launcher.
    pub(crate) loopback_consent_prompt: Arc<dyn crate::ports::LoopbackConsentPrompt>,
    /// The host Owner's grant, parsed from
    /// [`AuthorizationServerConfig::host_owner_scopes`](crate::AuthorizationServerConfig::host_owner_scopes)
    /// — the approving authority when the Owner answers the loopback dialog,
    /// the same scopes the host owner token carries.
    pub(crate) host_owner_grant: wildflowerhealthio_scopes::Grant,
    /// The outstanding same-device sign-in codes: minted in-process by the
    /// [`SameDeviceSignInCodeMinter`](crate::SameDeviceSignInCodeMinter)
    /// [`crate::setup_authorization_server`] hands the host, redeemed at
    /// `/oauth/sign-in`.
    pub(crate) same_device_sign_in_codes: Arc<SameDeviceSignInCodes>,
    /// Where `/oauth/sign-in` may send a browser next: this server's paths,
    /// the hosted launcher and the Wildflower Authorization app, built at
    /// [`crate::setup_authorization_server`] from the server's origin,
    /// [`launcher_base`](Self::launcher_base) and
    /// [`AuthorizationServerConfig::authorization_app_base`](crate::AuthorizationServerConfig::authorization_app_base).
    pub(crate) sign_in_destinations: Arc<SignInDestinations>,
}

impl AuthorizationServerState {
    /// The lock on the Wildflower host app's client, over
    /// [`wildflower_host_app_client_id`](Self::wildflower_host_app_client_id).
    pub(crate) fn host_app_client_lock(&self) -> HostAppClientLock {
        HostAppClientLock::new(self.wildflower_host_app_client_id.clone())
    }

    /// The [`Revocation`] port the capabilities revoke through: the shared
    /// [`revocation_store`](Self::revocation_store), behind the
    /// [`host_app_client_lock`](Self::host_app_client_lock).
    pub(crate) fn revocation(&self) -> Arc<dyn Revocation> {
        Arc::new(HostAppLockedRevocation::new(
            Arc::new(self.revocation_store.clone()),
            self.host_app_client_lock(),
        ))
    }
}

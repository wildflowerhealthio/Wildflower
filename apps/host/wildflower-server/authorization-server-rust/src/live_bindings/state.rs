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
use url::Url;

use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_token_revocation::RevocationStore;

use crate::db::SqliteGrantStore;
use crate::domain::essential_client_guard::EssentialClientGuard;
use crate::domain::pending_consent::NewestPendingConsent;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::domain::sign_in_redirect::SignInDestinations;
use crate::ports::{AuthorizationStartGate, Revocation, RevocationCheck};

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
    /// The server's bare origin (`https://<domain>`), reduced once from
    /// [`AuthorizationServerConfig::server_origin`](crate::AuthorizationServerConfig::server_origin)
    /// at [`crate::setup_authorization_server`]: the `iss` and `aud` of every token this
    /// server mints, and the only ones its
    /// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier)
    /// accepts. An `Arc<str>` so each capability built from the state shares it.
    pub(crate) server_origin: Arc<str>,
    /// This server's device verification page, `https://<domain>/oauth/device`:
    /// the RFC 8628 `verification_uri` `/oauth/device_authorization` hands
    /// out, built once at [`crate::setup_authorization_server`]. An `Arc` so
    /// each [`DeviceAuthorizer`](crate::domain::capabilities::oauth::DeviceAuthorizer)
    /// built from the state shares it.
    pub(crate) device_page: Arc<Url>,
    /// The Wildflower host app's `client_id`, pinned from
    /// [`AuthorizationServerConfig`](crate::AuthorizationServerConfig) at
    /// [`crate::setup_authorization_server`] — the same id [`crate::seeding`] seeds the
    /// host app's client row under (both sourced from `tauri-shared-config.json`
    /// on the live app). `/token` matches a request's presented `client_id`
    /// against it to hold it to its fixed registration. An `Arc<str>` so the string is
    /// shared rather than reallocated when the state is cloned before the `Arc`
    /// wrap.
    pub(crate) wildflower_host_app_client_id: Arc<str>,
    /// The hosted launcher logout lands the browser on, pinned from
    /// [`AuthorizationServerConfig`](crate::AuthorizationServerConfig) at [`crate::setup_authorization_server`].
    pub(crate) launcher_base: LauncherBase,
    /// Watch sender publishing the [`NewestPendingConsent`] the host notifies
    /// and the base shows on the server's page. Handlers whose write may change it call the
    /// [`OwnerApproval::republish_active`](crate::ports::OwnerApproval::republish_active)
    /// seam after the write completes.
    pub(crate) owner_approval_tx: watch::Sender<Option<NewestPendingConsent>>,
    /// Pinged each time
    /// [`OwnerApproval::republish_active`](crate::ports::OwnerApproval::republish_active)
    /// recomputes the newest pending consent, whether or not it changed: what
    /// the [`PendingConsentWatcher`](crate::PendingConsentWatcher) rereads its
    /// request on.
    pub(crate) pending_consents_recomputed_tx: watch::Sender<()>,
    /// The Owner's grant, [`crate::OWNER_SCOPES`] — what an Owner
    /// session holds, the authority it decides consents with.
    pub(crate) owner_grant: wildflowerhealthio_scopes::Grant,
    /// The outstanding same-device sign-in codes: minted in-process by the
    /// [`SameDeviceSignInCodeMinter`](crate::SameDeviceSignInCodeMinter)
    /// [`crate::setup_authorization_server`] hands the host, redeemed at
    /// `/oauth/sign-in`.
    pub(crate) same_device_sign_in_codes: Arc<SameDeviceSignInCodes>,
    /// Where `/oauth/sign-in` may send a browser next: this server's paths,
    /// the hosted launcher, the Wildflower Authorization app, and the launcher
    /// and Authorization app the host opens for this server, built at
    /// [`crate::setup_authorization_server`] from the server's origin,
    /// [`launcher_base`](Self::launcher_base),
    /// [`AuthorizationServerConfig::authorization_app_base`](crate::AuthorizationServerConfig::authorization_app_base),
    /// [`AuthorizationServerConfig::launcher_url`](crate::AuthorizationServerConfig::launcher_url)
    /// and
    /// [`AuthorizationServerConfig::authorization_url`](crate::AuthorizationServerConfig::authorization_url).
    pub(crate) sign_in_destinations: Arc<SignInDestinations>,
    /// The host's say over how fast authorization requests are started,
    /// handed to [`crate::setup_authorization_server`]: asked by the limit on
    /// `/oauth/authorize` and `/oauth/device_authorization` for each request
    /// that carries no live browser session.
    pub(crate) authorization_start_gate: Arc<dyn AuthorizationStartGate>,
}

impl AuthorizationServerState {
    /// The guard on the essential clients: the host app's,
    /// [`wildflower_host_app_client_id`](Self::wildflower_host_app_client_id),
    /// and the browser-session client, [`crate::BROWSER_SESSION_CLIENT_ID`].
    pub(crate) fn essential_client_guard(&self) -> EssentialClientGuard {
        EssentialClientGuard::new(
            self.wildflower_host_app_client_id.clone(),
            crate::BROWSER_SESSION_CLIENT_ID.into(),
        )
    }

    /// The [`Revocation`] port the capabilities revoke through: the shared
    /// [`revocation_store`](Self::revocation_store).
    pub(crate) fn revocation(&self) -> Arc<dyn Revocation> {
        Arc::new(self.revocation_store.clone())
    }

    /// The [`RevocationCheck`] port the token verifier and refresh redemption
    /// read through: the same shared
    /// [`revocation_store`](Self::revocation_store).
    pub(crate) fn revocation_check(&self) -> Arc<dyn RevocationCheck> {
        Arc::new(self.revocation_store.clone())
    }
}

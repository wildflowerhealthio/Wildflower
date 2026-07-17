//! The shared gatekeeper runtime state — the router state every handler is built
//! over, and the composition point that wires the concrete adapters
//! ([`SqliteGatekeeperStore`], [`RevocationStore`]) to the domain ports. It lives
//! at the crate root (not under [`crate::http`]) deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it,
//! and `domain/` must not depend on `crate::http`. The struct itself is
//! axum-free; the one axum-touching seam impl (`SessionCookies`, which takes a
//! `HeaderMap`) stays in [`crate::http`].
//!
//! The capability-binding `FixedScopeCapability`/`Capability` impls live here too
//! (see [`capability_bindings`]): they name the concrete `SqliteGatekeeperStore`
//! and lift the store + port handles out of the state, so the generic,
//! store-agnostic capabilities in `domain/` never mention a concrete adapter.

mod capability_bindings;

pub(crate) use capability_bindings::{
    ConsentDeciderCap, ConsentReaderCap, GrantsReaderCap, GrantsRevokerCap, TokenRevokerCap,
};

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::watch;

use token_revocation_rust::RevocationStore;

use crate::db::SqliteGatekeeperStore;
use crate::domain::GatekeeperStore;
use crate::ports::{DeviceUserCodePublisher, Revocation};

/// Shared state threaded through every gatekeeper handler and lifted into the
/// scope-gated capabilities. Opaque to callers outside the crate — the host
/// receives one (inside an [`Arc`]) from [`crate::setup_gatekeeper`] and passes
/// it back into [`crate::layer_router_with_gatekeeper_auth_gating`] without
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
    /// revoke) writes to it through the [`Revocation`] port. Cheap to clone — it
    /// wraps the same shared connection every other slice holds. The host builds
    /// one and threads it into both [`crate::setup_gatekeeper`] and emr-rust's
    /// HFS adapter, so the two enforcement points read one store.
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
    /// Watch sender that publishes the `user_code` of the
    /// currently-active pending device-code consent request — the head
    /// the host webview surfaces in its non-dismissable popup. Handlers
    /// whose write may change the head call
    /// [`Self::republish_active_device_user_code`] after the write
    /// completes; the host-side bridge task forwards the value over the
    /// `bridge:DeviceConsentRequested` event and focuses the window when
    /// it goes to `Some`.
    pub(crate) active_device_user_code_sender: watch::Sender<Option<String>>,
}

impl GatekeeperState {
    /// Recompute the head of the pending device-code consent queue from
    /// the store and publish it through the bridge's watch sender. Call
    /// after every transition that may change the head (`/oauth/device_authorization`
    /// insert, `/oauth/authorize` insert, `/access/devices/{userCode}/approve`,
    /// `/access/devices/{userCode}/deny`).
    ///
    /// The DB read happens *inside* `send_if_modified`, so the watch
    /// sender's internal lock serialises the read+publish pair across
    /// concurrent callers: whichever caller commits last to SQLite is
    /// also whichever publishes last to the watch (and the published
    /// value matches what is in the DB at that moment). Without this,
    /// a thread that read its head before a concurrent thread's
    /// commit could overwrite the watch with a stale head after the
    /// concurrent publish — the popup would advertise a `user_code`
    /// whose row was already handled.
    ///
    /// Uses `send_if_modified` so a transition that leaves the head
    /// unchanged (e.g. denying a non-head request) does not produce a
    /// spurious bridge event — the host's window-focus path only wakes
    /// on real head changes.
    ///
    /// On a DB-read failure the watch is *cleared* to `None`: the
    /// popup closing on a transient query failure is strictly better
    /// than leaving it stuck on a head the user just handled. A
    /// surviving pending row will republish on the next mutation or
    /// reaper tick.
    pub(crate) fn republish_active_device_user_code(&self) {
        self.active_device_user_code_sender
            .send_if_modified(|current| {
                let next = match self.store.oldest_pending_device_user_code() {
                    Ok(next) => next,
                    Err(error) => {
                        tracing::warn!(
                            "oldest_pending_device_user_code query failed; clearing popup head: {error}"
                        );
                        None
                    }
                };
                if *current == next {
                    false
                } else {
                    *current = next;
                    true
                }
            });
    }
}

/// The device-consent republish seam ([`crate::ports`]) the consent capability
/// forwards to after a device-flow store write — delegates to the inherent
/// recompute-and-publish. Implemented on the bare state so an
/// `Arc<GatekeeperState>` coerces to an `Arc<dyn DeviceUserCodePublisher>` the
/// capability holds.
impl DeviceUserCodePublisher for GatekeeperState {
    fn republish_active(&self) {
        self.republish_active_device_user_code();
    }
}

/// The token-revocation seam — delegates to the shared [`RevocationStore`],
/// stringifying its error so the port stays free of the store's concrete type.
/// The capabilities hold an `Arc<dyn Revocation>` built from a cloned store.
impl Revocation for RevocationStore {
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String> {
        RevocationStore::revoke_jti(self, jti, expires_at, reason).map_err(|e| e.to_string())
    }

    fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String> {
        RevocationStore::revoke_subject_as_of_now(self, subject).map_err(|e| e.to_string())
    }
}

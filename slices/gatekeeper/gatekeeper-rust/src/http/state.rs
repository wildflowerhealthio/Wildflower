use tokio::sync::watch;

use crate::db::GatekeeperStore;

/// Shared state threaded through every gatekeeper handler. Opaque to
/// callers outside the crate — the host receives one from
/// [`crate::setup_gatekeeper`] and passes it back into
/// [`crate::layer_router_with_gatekeeper_auth_gating`] without looking
/// inside.
#[derive(Clone)]
pub struct AppState {
    pub(crate) store: GatekeeperStore,
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
    /// against it to grant first-party treatment. An `Arc<str>` so the
    /// frequently-cloned `AppState` doesn't reallocate the string.
    pub(crate) first_party_client_id: std::sync::Arc<str>,
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

impl AppState {
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

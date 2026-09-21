//! The consent-head republish seam ([`crate::ports`]) adapted onto the bare
//! [`GatekeeperState`]. See the [module docs](super) for the composition layer.

use crate::live_bindings::state::GatekeeperState;
use crate::ports::PendingConsentPublisher;
use crate::GatekeeperStore;

/// The consent-head republish seam ([`crate::ports`]) the consent capability
/// forwards to after a store write — delegates to the inherent
/// recompute-and-publish. Implemented on the bare state so an
/// `Arc<GatekeeperState>` coerces to an `Arc<dyn PendingConsentPublisher>` the
/// capability holds.
impl PendingConsentPublisher for GatekeeperState {
    /// Recompute the head of the pending-consent queue from the store and
    /// publish it through the bridge's watch sender. Call after every transition
    /// that may change the head (`/oauth/device_authorization` insert,
    /// `/oauth/authorize` insert, `/access/oauth-consents/{id}/approve`,
    /// `/access/oauth-consents/{id}/deny`, `/access/devices/{userCode}/approve`,
    /// `/access/devices/{userCode}/deny`).
    ///
    /// The DB read happens *inside* `send_if_modified`, so the watch
    /// sender's internal lock serialises the read+publish pair across
    /// concurrent callers: whichever caller commits last to SQLite is
    /// also whichever publishes last to the watch (and the published
    /// value matches what is in the DB at that moment). Without this,
    /// a thread that read its head before a concurrent thread's
    /// commit could overwrite the watch with a stale head after the
    /// concurrent publish — the popup would advertise a request
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
    fn republish_active(&self) {
        self.active_pending_consent_sender
            .send_if_modified(|current| {
                let next = match self.store.oldest_pending_consent_head() {
                    Ok(next) => next,
                    Err(error) => {
                        tracing::warn!(
                            "oldest_pending_consent_head query failed; clearing popup head: {error}"
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

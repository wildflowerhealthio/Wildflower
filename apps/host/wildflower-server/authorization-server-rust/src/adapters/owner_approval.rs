//! The newest-pending-consent republish seam ([`crate::ports`]) adapted onto the bare
//! [`AuthorizationServerState`]. See the [module docs](super) for the composition layer.

use chrono::Utc;

use crate::domain::grant_store::AuthorizationRequestsTx as _;
use crate::live_bindings::state::AuthorizationServerState;
use crate::ports::OwnerApproval;
use crate::GrantStore;

/// The newest-pending-consent republish seam ([`crate::ports`]) the consent capability
/// forwards to after a store write — delegates to the inherent
/// recompute-and-publish. Implemented on the bare state so an
/// `Arc<AuthorizationServerState>` coerces to an `Arc<dyn OwnerApproval>` the
/// capability holds.
impl OwnerApproval for AuthorizationServerState {
    /// Recompute the newest pending consent from the store and publish it on
    /// its watch sender. Call after every transition that may change it (see
    /// [`OwnerApproval`]).
    ///
    /// The DB read happens *inside* `send_if_modified`, so the watch
    /// sender's internal lock serialises the read+publish pair across
    /// concurrent callers: whichever caller commits last to SQLite is
    /// also whichever publishes last to the watch (and the published
    /// value matches what is in the DB at that moment). Without this,
    /// a thread that read the newest request before a concurrent thread's
    /// commit could overwrite the watch with a stale one after the
    /// concurrent publish — the host would advertise a request
    /// whose row was already handled.
    ///
    /// Uses `send_if_modified` so a transition that leaves the newest
    /// request unchanged (e.g. denying an older one) does not produce a
    /// spurious change of the server's status.
    ///
    /// On a DB-read failure the watch keeps what it holds: `None` there
    /// says nothing is pending, which the host takes to mean every request
    /// it notified for is settled, so a transient failure publishing it
    /// would re-notify each one still waiting. A request handled meanwhile
    /// drops off on the next mutation or reaper tick that reads.
    ///
    /// Either way it then pings `pending_consents_recomputed_tx`, so a
    /// [`PendingConsentWatcher`](crate::PendingConsentWatcher) rereads its
    /// request: one decided or expired while a newer one stays newest
    /// changes nothing on the watch above.
    fn republish_active(&self) {
        self.owner_approval_tx.send_if_modified(|current| {
            let next = match self.store.read(|tx| tx.owner_prompt(Utc::now())) {
                Ok(next) => next,
                Err(error) => {
                    tracing::warn!("owner_prompt query failed; keeping the last: {error}");
                    return false;
                }
            };
            if *current == next {
                false
            } else {
                *current = next;
                true
            }
        });
        self.pending_consents_recomputed_tx.send_replace(());
    }
}

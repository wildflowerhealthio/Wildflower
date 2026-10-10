//! [`PendingConsentPublisher`] — the seam a consent-queue transition calls to
//! republish the active popup head after it changes the pending queue.

/// Republish the head of the pending-consent queue over the bridge.
///
/// Any transition that may change which request is first in line — a fresh
/// `/oauth/device_authorization` or `/oauth/authorize` insert, an approve or a
/// deny on either consent surface — calls this after the store write, so the
/// host's popup opens, advances, or closes to match. The real implementation
/// ([`GatekeeperState`](crate::http::GatekeeperState)) recomputes the head from
/// the store and publishes it through the bridge watch channel; a test fake just
/// records that it was asked to.
pub(crate) trait PendingConsentPublisher: Send + Sync + 'static {
    /// Recompute and republish the active pending-consent head.
    fn republish_active(&self);
}

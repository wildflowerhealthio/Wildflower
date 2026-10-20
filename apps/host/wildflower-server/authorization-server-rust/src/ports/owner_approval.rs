//! [`OwnerApproval`] — asking the Owner: the seam a pending-consent
//! transition calls to republish the request awaiting the Owner's approval
//! after it changes which requests are pending.

/// Republish the [`OwnerPrompt`](crate::OwnerPrompt), the newest request
/// awaiting the Owner, to the host.
///
/// Any transition that may change which pending request is newest — a fresh
/// `/oauth/device_authorization` or `/oauth/authorize` insert, a browser
/// pairing's start or rename, a prompt raised for the Owner, an approve or a
/// deny on either consent surface — calls this after the store write, so the
/// host notifies a new request and its server page shows the one pending. The
/// real implementation (in `crate::adapters`, on
/// [`AuthorizationServerState`](crate::http::AuthorizationServerState)) recomputes the
/// Owner prompt from the store and publishes it on its watch channel; a test
/// fake just records that it was asked to.
pub(crate) trait OwnerApproval: Send + Sync + 'static {
    /// Recompute and republish the Owner prompt.
    fn republish_active(&self);
}

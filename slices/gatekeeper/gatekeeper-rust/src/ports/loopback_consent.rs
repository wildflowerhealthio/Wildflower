//! [`LoopbackConsentPrompt`] — the seam the `/authorize` handler calls to raise
//! a native OS dialog when a direct-loopback caller presents the
//! `wildflower-react` `client_id`. The host (Tauri) implements it with a
//! blocking platform dialog; a host with no native prompt (and tests) wires
//! [`NoLoopbackConsentPrompt`], which always denies — falling through to the
//! normal Owner UI consent path.

use crate::domain::client_registration::ClientRegistration;

/// The request data the loopback consent dialog shows to the Owner.
#[derive(Debug, Clone)]
pub struct LoopbackConsentRequest {
    /// The OAuth `client_id` of the requesting application.
    pub client_id: String,
    /// The origin the redirect will land on (the `redirect_uri`'s origin).
    pub redirect_origin: String,
    /// How this request compares against the client's registration — the
    /// wording the dialog adapts ("first time from this address" / "new address
    /// for a known app" / "known app").
    pub registration: ClientRegistration,
    /// The requested scopes, already split from the whitespace-delimited param.
    pub requested_scopes: Vec<String>,
    /// The authorization request id — the unique id parked in the store.
    pub request_id: String,
}

/// The Owner's decision from the native loopback dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopbackConsentDecision {
    /// The Owner approved the login.
    Approve,
    /// The Owner rejected, dismissed, or let the dialog time out.
    Deny,
}

/// Raise a native owner-approval dialog for a direct-loopback login. The call
/// blocks (on a `spawn_blocking` worker) until the Owner decides or the dialog
/// times out; both paths return a [`LoopbackConsentDecision`].
///
/// The host implements this with a platform dialog (e.g.
/// `tauri_plugin_dialog::DialogExt`); [`NoLoopbackConsentPrompt`] always denies,
/// so a host without native dialog support falls through to the normal Owner UI
/// consent page.
pub trait LoopbackConsentPrompt: Send + Sync + 'static {
    fn ask(&self, request: LoopbackConsentRequest) -> LoopbackConsentDecision;
}

/// A [`LoopbackConsentPrompt`] that always denies — the safe default for hosts
/// without native dialog support and for tests that don't wire a recording
/// fake. Denial falls through to the normal Owner UI consent path.
#[derive(Debug, Clone, Copy)]
pub struct NoLoopbackConsentPrompt;

impl LoopbackConsentPrompt for NoLoopbackConsentPrompt {
    fn ask(&self, _request: LoopbackConsentRequest) -> LoopbackConsentDecision {
        LoopbackConsentDecision::Deny
    }
}

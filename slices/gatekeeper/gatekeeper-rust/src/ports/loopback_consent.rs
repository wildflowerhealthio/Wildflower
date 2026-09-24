//! [`LoopbackConsentPrompt`] — the seam through which `/authorize` asks the
//! host to put a login in front of the Owner at the machine, as a native OS
//! dialog, when the hosted owner UI (`wildflower-react`) logs in over direct
//! loopback.
//!
//! The dialog is one more approver of the parked request, not a replacement for
//! the Owner UI: `/authorize` still sends the browser to the wait page, and
//! whichever surface decides first wins. The host implements the seam (the
//! Tauri app with `tauri-plugin-dialog`); a host with no native dialog (and the
//! tests) wires [`NoLoopbackConsentPrompt`], which abstains, leaving the request
//! for the Owner UI exactly as if the seam did not exist.

use chrono::{DateTime, Utc};

/// The login the dialog asks the Owner about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackConsentRequest {
    /// The parked authorization request's id.
    pub request_id: String,
    /// The OAuth `client_id` the login presented.
    pub client_id: String,
    /// The origin of the presented `redirect_uri` — where the browser lands
    /// with the code, and so the one fact that tells the Owner which page is
    /// asking (any local process can present the `client_id`).
    pub redirect_origin: String,
    /// How the login compares with what the Owner has approved before.
    pub registration_notice: LoopbackRegistrationNotice,
    /// The requested scopes, in request order.
    pub requested_scopes: Vec<String>,
    /// When the parked request expires. An answer after this is ignored, and
    /// gatekeeper stops waiting for one (treating the silence as a reject).
    pub expires_at: DateTime<Utc>,
}

/// The registration warning the dialog carries — the loopback dialog's
/// rendering of the request's registration verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopbackRegistrationNotice {
    /// No client with this id has been approved before.
    NewApp,
    /// The client is known, but its redirect origin is not one approved before.
    NewAddress,
    /// The client and its redirect were approved before.
    KnownApp,
}

impl LoopbackRegistrationNotice {
    /// The one-line wording the dialog shows for this notice.
    pub fn describe(self) -> &'static str {
        match self {
            LoopbackRegistrationNotice::NewApp => "first time from this address",
            LoopbackRegistrationNotice::NewAddress => "new address for a known app",
            LoopbackRegistrationNotice::KnownApp => "known app",
        }
    }
}

/// The Owner's answer to the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopbackConsentAnswer {
    /// Approve: issue the login a code for the requested scopes the host
    /// Owner holds.
    Approve,
    /// Reject — including closing the dialog: the login is denied
    /// (`access_denied`).
    Reject,
    /// No dialog was shown (the host has none, or one is already on screen):
    /// the request stays pending for the Owner UI to decide.
    Abstain,
}

/// Put a loopback login in front of the Owner. `ask` blocks until the Owner
/// answers; gatekeeper calls it on a blocking worker, and stops waiting at the
/// request's [`expires_at`](LoopbackConsentRequest::expires_at).
pub trait LoopbackConsentPrompt: Send + Sync {
    /// Show the dialog for `request` and return the Owner's answer.
    fn ask(&self, request: &LoopbackConsentRequest) -> LoopbackConsentAnswer;
}

/// A [`LoopbackConsentPrompt`] with no dialog: it always
/// [abstains](LoopbackConsentAnswer::Abstain), so every loopback login is
/// decided in the Owner UI. The default for a host without native dialogs and
/// for tests that don't exercise the dialog.
#[derive(Debug, Clone, Copy)]
pub struct NoLoopbackConsentPrompt;

impl LoopbackConsentPrompt for NoLoopbackConsentPrompt {
    fn ask(&self, _request: &LoopbackConsentRequest) -> LoopbackConsentAnswer {
        LoopbackConsentAnswer::Abstain
    }
}

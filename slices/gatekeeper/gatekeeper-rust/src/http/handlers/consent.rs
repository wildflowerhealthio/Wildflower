//! Shared machinery for the two Owner consent surfaces —
//! `/oauth-consents/{id}` (authorization-code flow) and `/devices/{userCode}`
//! (device-code flow, RFC 8628). The two differ in how they load a pending
//! request, and the code flow additionally mints an authorization code on
//! approval; but they agree on the wire shapes the Owner UI posts and reads
//! ([`ApproveBody`], [`ConsentResult`]), on the rule for which scopes an
//! approval may actually grant ([`scopes_rust::grantable_scopes`]), and on
//! the deny path ([`deny_consent`]). Keeping the wire shapes and deny path
//! here stops the two trees from drifting — the divergence that once let the
//! device path skip the `allowed_scopes` clamp the code path already had.

use axum::Json;
use serde::{Deserialize, Serialize};

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// Body posted by the Owner UI to approve a consent prompt: the scopes the
/// Owner ticked, plus an optional patient context to bind to the grant. The
/// device flow sends no `patient` today, so it deserializes to `None`; the
/// field is shared in anticipation of device-flow patient selection.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveBody {
    pub(crate) approved_scopes: Vec<String>,
    pub(crate) patient: Option<String>,
    /// An optional adjusted device name (device flow only — the settings approver
    /// renaming the device before approving). `None` on the code-flow path and
    /// when the approver didn't change it; `COALESCE`d server-side so the stored
    /// name is preserved.
    #[serde(default)]
    pub(crate) device_name: Option<String>,
}

/// Result the Owner UI sees after approving or denying a consent prompt.
///
/// A code-flow approval carries the client callback URL (`code` + `state`
/// appended to the client's `redirect_uri`) so the approving surface can
/// complete the flow directly when the approver *is* the requesting client —
/// no separate poll of `/oauth/authorize/{id}` needed. Device-flow approvals
/// have no client `redirect_uri`, so `redirect` is `None` and (thanks to
/// `skip_serializing_if`) omitted from the wire entirely.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ConsentResult {
    Approved {
        #[serde(skip_serializing_if = "Option::is_none")]
        redirect: Option<String>,
    },
    Denied,
}

/// Mark the pending request `request_id` denied and return the Owner-UI
/// result. Each flow loads/validates the request with its own loader first,
/// then funnels both the explicit-deny route and the nothing-granted route of
/// `approve` through here, so the deny side stays identical across both trees.
///
/// Also republishes the active device-consent head: a device-flow deny
/// may have just resolved the popup's head, so the modal needs to close
/// (or jump to the next queued request). Code-flow denies are no-ops
/// against the device-only query, so the call is safe to make here
/// unconditionally rather than threading a `grant_type` argument.
pub(crate) fn deny_consent(
    state: &AppState,
    request_id: &str,
) -> Result<Json<ConsentResult>, HandlerError> {
    state
        .store
        .deny_authorization_request(request_id)
        .map_err(|e| HandlerError::internal("deny_authorization_request failed", e))?;
    state.republish_active_device_user_code();
    Ok(Json(ConsentResult::Denied))
}

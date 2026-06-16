//! Shared machinery for the two Owner consent surfaces —
//! `/oauth-consents/{id}` (authorization-code flow) and `/devices/{userCode}`
//! (device-code flow, RFC 8628). The two differ in how they load a pending
//! request, and the code flow additionally mints an authorization code on
//! approval; but they agree on the wire shapes the Owner UI posts and reads
//! ([`ApproveBody`], [`ConsentResult`]), on the rule for which scopes an
//! approval may actually grant ([`grantable_scopes`]), and on the deny path
//! ([`deny_consent`]). Keeping those here stops the two trees from drifting —
//! the divergence that once let the device path skip the `allowed_scopes`
//! clamp the code path already had.

use std::collections::HashSet;

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
}

/// Result the Owner UI sees after approving or denying a consent prompt.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ConsentResult {
    Approved,
    Denied,
}

/// The scopes an Owner approval can actually grant: those that are both still
/// requested by the pending request and within the client's *current*
/// `allowed_scopes`. The Owner can only narrow, never widen, and the `allowed`
/// clamp stops a stale request from granting a scope the client's policy no
/// longer permits.
pub(crate) fn grantable_scopes(
    approved: Vec<String>,
    requested: &HashSet<&str>,
    allowed: &HashSet<&str>,
) -> Vec<String> {
    approved
        .into_iter()
        .filter(|s| requested.contains(s.as_str()) && allowed.contains(s.as_str()))
        .collect()
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

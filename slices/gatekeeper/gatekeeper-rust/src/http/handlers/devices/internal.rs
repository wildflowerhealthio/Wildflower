//! Shared types and the pending-request loader for the `/devices/{userCode}`
//! device-flow consent routes. The per-route handlers (`get`, `approve`,
//! `deny`) live in sibling modules and pull what they need from here.

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// Body returned to the Owner UI when it loads a pending device-code consent
/// prompt — describes the requesting client and its requested scopes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConsent {
    pub user_code: String,
    pub client_id: String,
    pub client_name: String,
    pub requested_scopes: Vec<String>,
}

/// Body posted by the Owner UI to approve a device-code consent prompt.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveBody {
    pub approved_scopes: Vec<String>,
}

/// Result the Owner UI sees after approving or denying a device-code consent.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConsentResult {
    Approved,
    Denied,
}

/// Load the authorization request for `user_code` and verify it's a pending
/// device-code flow. The error side is a [`HandlerError`] ("not found" or
/// "internal error"), so each handler can bail with `?` and move on.
pub(super) fn load_pending_device_request(
    state: &AppState,
    user_code: &str,
) -> Result<AuthorizationRequest, HandlerError> {
    match state
        .store
        .pending_authorization_request_by_user_code(user_code)
    {
        Ok(Some(r))
            if r.grant_type == GrantType::DeviceCode
                && r.status == RequestStatus::Pending
                && r.expires_at > Utc::now() =>
        {
            Ok(r)
        }
        Ok(_) => Err(HandlerError::not_found(
            "DeviceConsentNotFound",
            "userCode",
            user_code,
        )),
        Err(e) => Err(HandlerError::internal(
            "pending_authorization_request_by_user_code lookup failed",
            e,
        )),
    }
}

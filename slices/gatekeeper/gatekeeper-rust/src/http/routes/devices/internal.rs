//! Shared types and the pending-request loader for the `/devices/{userCode}`
//! device-flow consent routes. The per-route handlers (`get`, `approve`,
//! `deny`) live in sibling modules and pull what they need from here.

use chrono::Utc;
use serde::Serialize;

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// Body returned to the Owner UI when it loads a pending device-code consent
/// prompt — describes the requesting client, the device's chosen name, its
/// requested scopes, and the client's full allowed-scope set (the *expansion
/// envelope* the approver may grant up to, since device consent is expandable).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConsent {
    pub user_code: String,
    pub client_id: String,
    pub client_name: String,
    pub device_name: Option<String>,
    pub requested_scopes: Vec<String>,
    pub allowed_scopes: Vec<String>,
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

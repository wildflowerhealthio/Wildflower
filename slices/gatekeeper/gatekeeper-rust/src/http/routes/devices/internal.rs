//! The pending-request loader for the `/devices/{userCode}` device-flow
//! consent routes. The per-route handlers (`get`, `approve`, `deny`) live in
//! sibling modules; the wire DTO they serve ([`DeviceConsent`]) lives in
//! [`crate::http::wire_representations`].
//!
//! [`DeviceConsent`]: crate::http::wire_representations::DeviceConsent

use chrono::Utc;

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

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

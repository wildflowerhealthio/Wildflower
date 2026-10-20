use chrono::Utc;
use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::domain::authorization_request::polled::PolledRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{DeviceConsentView, Scoped};
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveConsentReader;

/// What asks at the device page: a device, through the RFC 8628 device-code
/// flow, or a browser pairing for a browser session. On the wire, `"device"`
/// or `"browser"`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DeviceConsentKind {
    Device,
    Browser,
}

/// Body returned to the launcher when it loads a pending device-page consent
/// prompt — what asks, the requesting client, the device's or browser's
/// name, the scopes the approver's ticks start from, and the *expansion
/// envelope* the approver may grant up to (device consent is expandable): a
/// device client's full allowed-scope set, a browser's the Owner's scopes.
/// Local to this one route (its only reader).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceConsent {
    pub(crate) kind: DeviceConsentKind,
    pub(crate) user_code: String,
    pub(crate) client_id: String,
    pub(crate) client_name: String,
    pub(crate) device_name: Option<String>,
    /// The scopes the approver's ticks start from: a device's requested
    /// scopes, or for a browser everything the caller may delegate.
    pub(crate) starting_scopes: Vec<String>,
    pub(crate) allowed_scopes: Vec<String>,
    /// The approval scopes the caller's own token lacks to approve this
    /// request (`wildflower/AuthorizationRequest.u`, and `wildflower/Grant.c`
    /// for a device's standing grant). Empty when it may approve; otherwise
    /// the device page sends the Owner to the device running the server.
    pub(crate) missing_approval_scopes: Vec<String>,
}

/// `GET /devices/{userCode}` — load a pending device-code consent prompt for
/// the launcher to render (scope `wildflower/AuthorizationRequest.r`).
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_get_device_consent)
}

async fn handle_get_device_consent(
    consents: Scoped<LiveConsentReader>,
    Path(user_code): Path<String>,
) -> Result<Json<DeviceConsent>, AuthorizationServerError> {
    let DeviceConsentView {
        request,
        client_name,
        starting_scopes,
        approvable_scopes,
        missing_approval_scopes,
    } = consents.device_consent(&user_code, Utc::now())?;
    let (kind, device_name) = match &request {
        PolledRequest::Pairing(pairing_request) => (
            DeviceConsentKind::Browser,
            Some(pairing_request.browser_name.clone()),
        ),
        PolledRequest::Device(device_request) => (
            DeviceConsentKind::Device,
            device_request.device_name.clone(),
        ),
    };
    Ok(Json(DeviceConsent {
        kind,
        user_code,
        client_id: request.client_id().to_owned(),
        client_name,
        device_name,
        starting_scopes,
        allowed_scopes: approvable_scopes,
        missing_approval_scopes,
    }))
}

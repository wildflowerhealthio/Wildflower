use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::facades::{ConsentReader, DeviceConsentView};
use crate::http::scoped::Scoped;
use crate::http::state::GatekeeperState;

/// Body returned to the Owner UI when it loads a pending device-code consent
/// prompt — describes the requesting client, the device's chosen name, its
/// requested scopes, and the client's full allowed-scope set (the *expansion
/// envelope* the approver may grant up to, since device consent is expandable).
/// Local to this one route (its only reader).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceConsent {
    pub(crate) user_code: String,
    pub(crate) client_id: String,
    pub(crate) client_name: String,
    pub(crate) device_name: Option<String>,
    pub(crate) requested_scopes: Vec<String>,
    pub(crate) allowed_scopes: Vec<String>,
}

/// `GET /devices/{userCode}` — load a pending device-code consent prompt for
/// the Owner UI to render (scope `wildflower/AuthorizationRequest.r`).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_get_device_consent)
}

async fn handle_get_device_consent(
    consents: Scoped<ConsentReader>,
    Path(user_code): Path<String>,
) -> Result<Json<DeviceConsent>, GatekeeperError> {
    let DeviceConsentView {
        request,
        client_name,
        allowed_scopes,
    } = consents.device_consent(&user_code)?;
    Ok(Json(DeviceConsent {
        user_code,
        client_id: request.client_id,
        client_name,
        device_name: request.device_name,
        requested_scopes: request.requested_scopes,
        allowed_scopes,
    }))
}

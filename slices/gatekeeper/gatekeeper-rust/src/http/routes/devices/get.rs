use axum::extract::{Path, State};
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::domain::actions;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;

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
/// the Owner UI to render.
pub(super) fn route() -> MethodRouter<AppState> {
    get(handle_get_device_consent)
}

async fn handle_get_device_consent(
    State(state): State<AppState>,
    Path(user_code): Path<String>,
) -> Result<Json<DeviceConsent>, HandlerError> {
    let device_request = actions::load_pending_device_request(&state.store, &user_code)?;
    let (client_name, allowed_scopes) =
        match actions::client_by_id(&state.store, &device_request.client_id) {
            Ok(Some(c)) => (c.name, c.allowed_scopes),
            // Fall back to the raw client_id (and no expansion envelope) if lookup
            // misses or fails — the UI still works, the approver just sees less
            // context and can only grant within the requested set.
            _ => (device_request.client_id.clone(), Vec::new()),
        };
    Ok(Json(DeviceConsent {
        user_code,
        client_id: device_request.client_id,
        client_name,
        device_name: device_request.device_name,
        requested_scopes: device_request.requested_scopes,
        allowed_scopes,
    }))
}

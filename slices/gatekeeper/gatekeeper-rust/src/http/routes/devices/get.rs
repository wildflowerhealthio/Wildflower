use axum::extract::{Path, State};
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::consent::load_pending_device_request;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;
use crate::http::wire_representations::DeviceConsent;

/// `GET /devices/{userCode}` — load a pending device-code consent prompt for
/// the Owner UI to render.
pub(super) fn route() -> MethodRouter<AppState> {
    get(handle_get_device_consent)
}

async fn handle_get_device_consent(
    State(state): State<AppState>,
    Path(user_code): Path<String>,
) -> Result<Json<DeviceConsent>, HandlerError> {
    let device_request = load_pending_device_request(&state.store, &user_code)?;
    let (client_name, allowed_scopes) = match state.store.client_by_id(&device_request.client_id) {
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

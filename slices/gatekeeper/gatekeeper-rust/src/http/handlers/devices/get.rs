use axum::extract::{Extension, Path};
use axum::routing::{get, MethodRouter};
use axum::Json;

use super::internal::{load_pending_device_request, DeviceConsent};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `GET /devices/{userCode}` — load a pending device-code consent prompt for
/// the Owner UI to render.
pub(super) fn route() -> MethodRouter {
    get(handle_get_device_consent)
}

async fn handle_get_device_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
) -> Result<Json<DeviceConsent>, HandlerError> {
    let device_request = load_pending_device_request(&state, &user_code)?;
    let client_name = match state.store.client_by_id(&device_request.client_id) {
        Ok(Some(c)) => c.name,
        // Fall back to the raw client_id if lookup misses or fails — the UI
        // still works, the operator just sees less context.
        _ => device_request.client_id.clone(),
    };
    Ok(Json(DeviceConsent {
        user_code,
        client_id: device_request.client_id,
        client_name,
        requested_scopes: device_request.requested_scopes.into_inner(),
    }))
}

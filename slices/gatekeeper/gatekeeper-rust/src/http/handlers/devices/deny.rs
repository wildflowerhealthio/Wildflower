use axum::extract::{Extension, Path};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::{load_pending_device_request, ConsentResult};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `POST /devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt.
pub(super) fn route() -> MethodRouter {
    post(handle_deny_device_consent)
}

async fn handle_deny_device_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let device_request = load_pending_device_request(&state, &user_code)?;
    state
        .store
        .deny_authorization_request(&device_request.id)
        .map_err(|e| HandlerError::internal("deny_authorization_request failed", e))?;
    Ok(Json(ConsentResult::Denied))
}

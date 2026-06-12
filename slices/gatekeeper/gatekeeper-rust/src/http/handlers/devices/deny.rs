use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::{load_pending_device_request, ConsentResult};
use crate::http::response_templates;
use crate::http::state::AppState;

/// `POST /devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt.
pub(super) fn route() -> MethodRouter {
    post(handle_deny_device_consent)
}

async fn handle_deny_device_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
) -> Response {
    let device_request = match load_pending_device_request(&state, &user_code) {
        Ok(r) => r,
        Err(response) => return *response,
    };
    if let Err(e) = state.store.deny_authorization_request(&device_request.id) {
        return response_templates::internal_error("deny_authorization_request failed", e);
    }
    Json(ConsentResult::Denied).into_response()
}

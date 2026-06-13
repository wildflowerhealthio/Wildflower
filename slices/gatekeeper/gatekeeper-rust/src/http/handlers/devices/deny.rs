use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::load_pending_device_request;
use crate::http::handlers::consent::{deny_consent, ConsentResult};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `POST /devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_deny_device_consent)
}

async fn handle_deny_device_consent(
    State(state): State<AppState>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let device_request = load_pending_device_request(&state, &user_code)?;
    deny_consent(&state, &device_request.id)
}

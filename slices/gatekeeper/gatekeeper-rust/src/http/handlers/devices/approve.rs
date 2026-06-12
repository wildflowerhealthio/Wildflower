use std::collections::HashSet;

use axum::extract::{Extension, Path};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::{load_pending_device_request, ApproveBody, ConsentResult};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `POST /devices/{userCode}/approve` — the Owner approves a device-code
/// consent prompt, granting the (narrowed) scope set.
pub(super) fn route() -> MethodRouter {
    post(handle_approve_device_consent)
}

async fn handle_approve_device_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let device_request = load_pending_device_request(&state, &user_code)?;
    let requested: HashSet<&str> = device_request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    let granted_scopes: Vec<String> = body
        .approved_scopes
        .into_iter()
        .filter(|s| requested.contains(s.as_str()))
        .collect();
    if granted_scopes.is_empty() {
        // No requested scopes were approved — treat as a deny.
        state
            .store
            .deny_authorization_request(&device_request.id)
            .map_err(|e| HandlerError::internal("deny_authorization_request failed", e))?;
        return Ok(Json(ConsentResult::Denied));
    }
    state
        .store
        .approve_authorization_request(&device_request.id, &granted_scopes, None)
        .map_err(|e| HandlerError::internal("approve_authorization_request failed", e))?;
    Ok(Json(ConsentResult::Approved))
}

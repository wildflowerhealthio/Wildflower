use std::collections::HashSet;

use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::{load_pending_device_request, ApproveBody, ConsentResult};
use crate::http::response_templates;
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
) -> Response {
    let device_request = match load_pending_device_request(&state, &user_code) {
        Ok(r) => r,
        Err(response) => return *response,
    };
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
        if let Err(e) = state.store.deny_authorization_request(&device_request.id) {
            return response_templates::internal_error("deny_authorization_request failed", e);
        }
        return Json(ConsentResult::Denied).into_response();
    }
    if let Err(e) =
        state
            .store
            .approve_authorization_request(&device_request.id, &granted_scopes, None)
    {
        return response_templates::internal_error("approve_authorization_request failed", e);
    }
    Json(ConsentResult::Approved).into_response()
}

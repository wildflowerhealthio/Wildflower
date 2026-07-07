use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::load_pending_device_request;
use crate::http::handlers::consent::{deny_consent, ApproveBody, ConsentResult};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;
use scopes_rust::grantable_scopes;

/// `POST /devices/{userCode}/approve` — the Owner approves a device-code
/// consent prompt, granting the (narrowed) scope set.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_approve_device_consent)
}

async fn handle_approve_device_consent(
    State(state): State<AppState>,
    Path(user_code): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let device_request = load_pending_device_request(&state, &user_code)?;
    let requested_scopes: HashSet<&str> = device_request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    // Clamp the Owner's approval to what the client may *currently* hold, not
    // just what the (possibly stale) request asked for: a request created while
    // a scope was permitted must not grant it after an operator narrows the
    // client's `allowed_scopes`. Mirrors the code-flow consent path
    // (`oauth_consents::approve`).
    let client = state
        .store
        .client_by_id(&device_request.client_id)
        .map_err(|e| HandlerError::internal("client_by_id lookup failed", e))?
        // The request can't be approved against a client that no longer
        // exists — treat it as gone.
        .ok_or_else(|| HandlerError::not_found("DeviceConsentNotFound", "userCode", &user_code))?;
    let client_allowed_scopes: HashSet<&str> =
        client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(
        body.approved_scopes,
        &requested_scopes,
        &client_allowed_scopes,
    );
    if granted_scopes.is_empty() {
        // No requested-and-allowed scopes were approved — treat as a deny.
        // `deny_consent` republishes the active head itself.
        return deny_consent(&state, &device_request.id);
    }
    let approved = state
        .store
        .approve_authorization_request(&device_request.id, &granted_scopes, body.patient.as_deref())
        .map_err(|e| HandlerError::internal("approve_authorization_request failed", e))?;
    if !approved {
        // No longer pending (concurrently consumed/denied/expired) — treat as gone.
        return Err(HandlerError::not_found(
            "DeviceConsentNotFound",
            "userCode",
            &user_code,
        ));
    }
    // The popup's head may have just resolved; recompute and republish
    // so the modal either closes (no more pending) or jumps to the
    // next queued request.
    state.republish_active_device_user_code();
    // Device-code approvals have no client `redirect_uri` — the device polls
    // the token endpoint — so there's no client callback to hand back.
    Ok(Json(ConsentResult::Approved { redirect: None }))
}

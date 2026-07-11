use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use super::internal::load_pending_device_request;
use crate::http::response_templates::HandlerError;
use crate::http::routes::consent::deny_consent;
use crate::http::state::AppState;
use crate::http::wire_representations::{ApproveBody, ConsentResult};
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
    let client = state
        .store
        .client_by_id(&device_request.client_id)
        .map_err(|e| HandlerError::internal("client_by_id lookup failed", e))?
        // The request can't be approved against a client that no longer
        // exists — treat it as gone.
        .ok_or_else(|| HandlerError::not_found("DeviceConsentNotFound", "userCode", &user_code))?;
    let client_allowed_scopes: HashSet<&str> =
        client.allowed_scopes.iter().map(String::as_str).collect();
    // Device-code consent is EXPANDABLE (unlike the code-flow path): the Owner
    // pairing a device may grant scopes beyond what the device requested, up to
    // the client's `allowed_scopes`. So the request-side clamp is widened to
    // `client_allowed_scopes` (passed as both the requested and allowed
    // envelopes). Coverage-aware `grantable_scopes` still refuses anything the
    // client isn't allowed. The code-flow path (`oauth_consents::approve`) stays
    // clamped to `requested_scopes` — a third-party app can never widen its own
    // grant.
    let granted_scopes = grantable_scopes(
        body.approved_scopes,
        &client_allowed_scopes,
        &client_allowed_scopes,
    );
    if granted_scopes.is_empty() {
        // No allowed scopes were approved — treat as a deny.
        // `deny_consent` republishes the active head itself.
        return deny_consent(&state, &device_request.id);
    }
    let approved = state
        .store
        .approve_authorization_request(
            &device_request.id,
            &granted_scopes,
            body.patient.as_deref(),
            body.device_name.as_deref(),
        )
        .map_err(|e| HandlerError::internal("approve_authorization_request failed", e))?;
    if !approved {
        // No longer pending (concurrently consumed/denied/expired) — treat as gone.
        return Err(HandlerError::not_found(
            "DeviceConsentNotFound",
            "userCode",
            &user_code,
        ));
    }
    // Mint (or refresh) the durable device grant — the whole point of this
    // ticket: a device-code approval now leaves a standing record the owner can
    // see under "Authorized Devices" in Settings. Keyed on the *effective*
    // device name: the approver's adjustment, else the device's own name, else
    // the client's name (RFC 8628 requesters may not name themselves — a NOT
    // NULL default keeps the `(client_id, device_name)` upsert key total). Token
    // exchange resolves this same key to stamp `refresh_token_families.grant_id`.
    let effective_device_name = body
        .device_name
        .as_deref()
        .or(device_request.device_name.as_deref())
        .unwrap_or(client.name.as_str());
    state
        .store
        .upsert_device_grant(
            &device_request.client_id,
            effective_device_name,
            &granted_scopes,
            body.patient.as_deref(),
            Utc::now(),
        )
        .map_err(|e| HandlerError::internal("upsert_device_grant failed", e))?;
    // The popup's head may have just resolved; recompute and republish
    // so the modal either closes (no more pending) or jumps to the
    // next queued request.
    state.republish_active_device_user_code();
    // Device-code approvals have no client `redirect_uri` — the device polls
    // the token endpoint — so there's no client callback to hand back.
    Ok(Json(ConsentResult::Approved { redirect: None }))
}

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use super::internal::{
    load_pending_authorization_code_request, upsert_grant, PendingCodeConsent,
    AUTHORIZATION_CODE_TTL,
};
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_code::AuthorizationCode;
use crate::http::handlers::consent::{deny_consent, ApproveBody, ConsentResult};
use crate::http::handlers::oauth::build_client_redirect_url;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;
use persistence_rust::{JsonColumn, UriColumn};
use scopes_rust::grantable_scopes;

/// `POST /oauth-consents/{id}/approve` — the Owner approves a consent prompt,
/// granting a (narrowed) scope set and minting the authorization code the
/// polling endpoint hands back to the client.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_approve_oauth_consent)
}

async fn handle_approve_oauth_consent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let PendingCodeConsent {
        request,
        redirect_uri,
        code_challenge,
    } = load_pending_authorization_code_request(&state, &id)?;

    // The Owner can only narrow, never widen: intersect what they approved
    // with what the client requested (mirrors `devices.rs`), then clamp the
    // result to the client's `allowed_scopes` so a stale request can never
    // grant beyond the client's current policy.
    let requested: HashSet<&str> = request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    let client = state
        .store
        .client_by_id(&request.client_id)
        .map_err(|e| HandlerError::internal("client_by_id lookup failed", e))?
        // The request can't be approved against a client that no longer
        // exists — treat it as gone.
        .ok_or_else(|| HandlerError::not_found("OAuthConsentNotFound", "id", &id))?;
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(body.approved_scopes, &requested, &allowed);
    if granted_scopes.is_empty() {
        // No requested-and-allowed scopes were approved — treat as a deny.
        return deny_consent(&state, &id);
    }

    let approved = state
        .store
        .approve_authorization_request(&id, &granted_scopes, body.patient.as_deref(), None)
        .map_err(|e| HandlerError::internal("approve_authorization_request failed", e))?;
    if !approved {
        // No longer pending (concurrently consumed/denied/expired) — treat the
        // consent as gone rather than minting a code against a stale request.
        return Err(HandlerError::not_found("OAuthConsentNotFound", "id", &id));
    }

    // Mint and persist the authorization code so the polling endpoint's
    // `Approved` arm can hand the client back a redeemable `code`. Without
    // this, `authorization_code_by_request_id` returns `None` and the human
    // consent flow 500s ("Authorization code missing"). The PKCE
    // `code_challenge` was already unwrapped by the loader.
    let issued_at = Utc::now();
    let authorization_code = AuthorizationCode {
        code: generate_authorization_code(),
        request_id: id.clone(),
        client_id: request.client_id.clone(),
        redirect_uri: UriColumn(redirect_uri.clone()),
        code_challenge,
        granted_scopes: JsonColumn(granted_scopes.clone()),
        patient: body.patient.clone(),
        issued_at,
        expires_at: issued_at + AUTHORIZATION_CODE_TTL,
    };
    state
        .store
        .issue_authorization_code(&authorization_code)
        .map_err(|e| HandlerError::internal("issue_authorization_code failed", e))?;

    upsert_grant(
        &state,
        &request.client_id,
        &redirect_uri,
        &granted_scopes,
        body.patient.as_deref(),
    )
    .map_err(|e| HandlerError::internal("upsert_grant failed", e))?;

    // Hand back the client callback URL so an approving surface that *is* the
    // requesting client can finish the flow inline (mirrors `authorization_status`'s
    // `Approved` arm).
    //
    // `client_state` is `Option` only structurally: `/oauth/authorize` requires
    // `state` (see `authorize.rs`), so every stored code-flow request carries it
    // and the `None` branch is currently unreachable. Do NOT treat `None` as a
    // benign "fall back to polling": `authorization_status` returns `server_error`
    // for an approved request lacking `client_state`, so a state-less request 500s
    // there rather than recovering. Relaxing `state` to optional means revisiting
    // both paths together.
    let redirect = request.client_state.as_deref().map(|client_state| {
        build_client_redirect_url(&redirect_uri, &authorization_code.code, client_state)
    });
    Ok(Json(ConsentResult::Approved { redirect }))
}

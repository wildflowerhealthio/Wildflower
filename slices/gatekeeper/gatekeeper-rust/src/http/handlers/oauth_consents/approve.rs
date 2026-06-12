use std::collections::HashSet;

use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use super::internal::{
    grantable_scopes, load_pending_authorization_code_request, upsert_grant, ApproveBody,
    ConsentResult, PendingCodeConsent, AUTHORIZATION_CODE_TTL,
};
use crate::crypto_util::random_token::generate_authorization_code;
use crate::db_utils::{JsonColumn, UriColumn};
use crate::domain::authorization_code::AuthorizationCode;
use crate::http::response_templates;
use crate::http::state::AppState;

/// `POST /oauth-consents/{id}/approve` — the Owner approves a consent prompt,
/// granting a (narrowed) scope set and minting the authorization code the
/// polling endpoint hands back to the client.
pub(super) fn route() -> MethodRouter {
    post(handle_approve_oauth_consent)
}

async fn handle_approve_oauth_consent(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Response {
    let PendingCodeConsent {
        request,
        redirect_uri,
        code_challenge,
    } = match load_pending_authorization_code_request(&state, &id) {
        Ok(c) => c,
        Err(response) => return *response,
    };

    // The Owner can only narrow, never widen: intersect what they approved
    // with what the client requested (mirrors `devices.rs`), then clamp the
    // result to the client's `allowed_scopes` so a stale request can never
    // grant beyond the client's current policy.
    let requested: HashSet<&str> = request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    let client = match state.store.client_by_id(&request.client_id) {
        Ok(Some(c)) => c,
        // The request can't be approved against a client that no longer
        // exists — treat it as gone.
        Ok(None) => return response_templates::not_found("OAuthConsentNotFound", "id", &id),
        Err(e) => return response_templates::internal_error("client_by_id lookup failed", e),
    };
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(body.approved_scopes, &requested, &allowed);
    if granted_scopes.is_empty() {
        // No requested-and-allowed scopes were approved — treat as a deny.
        if let Err(e) = state.store.deny_authorization_request(&id) {
            return response_templates::internal_error("deny_authorization_request failed", e);
        }
        return Json(ConsentResult::Denied).into_response();
    }

    if let Err(e) =
        state
            .store
            .approve_authorization_request(&id, &granted_scopes, body.patient.as_deref())
    {
        return response_templates::internal_error("approve_authorization_request failed", e);
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
    if let Err(e) = state.store.issue_authorization_code(&authorization_code) {
        return response_templates::internal_error("issue_authorization_code failed", e);
    }

    if let Err(e) = upsert_grant(
        &state,
        &request.client_id,
        &redirect_uri,
        &granted_scopes,
        body.patient.as_deref(),
    ) {
        return response_templates::internal_error("upsert_grant failed", e);
    }
    Json(ConsentResult::Approved).into_response()
}

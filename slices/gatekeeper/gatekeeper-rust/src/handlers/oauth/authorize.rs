use axum::extract::{Extension, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use chrono::{Duration, Utc};
use serde::Deserialize;
use std::collections::HashSet;
use url::Url;
use uuid::Uuid;

use super::shared::build_client_redirect_url;
use crate::error_pages::{oauth_error_html, OAuthErrorKind};
use crate::page_paths;
use crate::require_auth::AppState;
use crate::store::authorization_code::AuthorizationCode;
use crate::store::authorization_request::{AuthorizationRequest, NewCodeFlow};
use crate::store::types::Json;

const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);
const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

#[derive(Debug, Deserialize)]
pub struct AuthorizeParams {
    pub code_challenge_method: String,
    pub client_id: String,
    pub scope: String,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
}

pub async fn handle(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    Query(params): Query<AuthorizeParams>,
) -> Response {
    let origin = state.origin.origin_for(&headers);

    // 1. Signing key must exist (503 if not).
    let signing_keys = match state.store.all_signing_keys() {
        Ok(k) => k,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if signing_keys.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    // 2. PKCE method
    if params.code_challenge_method != "S256" {
        return html_bad_request(oauth_error_html(
            OAuthErrorKind::UnsupportedCodeChallenge,
            Some(&params.code_challenge_method),
        ));
    }

    // 3. redirect_uri must be a well-formed http/https URL.
    let parsed_uri = match Url::parse(&params.redirect_uri) {
        Ok(u) => u,
        Err(_) => return html_bad_request(oauth_error_html(OAuthErrorKind::InvalidRedirectUri, None)),
    };
    if parsed_uri.scheme() != "http" && parsed_uri.scheme() != "https" {
        return html_bad_request(oauth_error_html(OAuthErrorKind::InvalidScheme, None));
    }

    // 4. Client must exist and be enabled.
    let client = match state.store.client_by_id(&params.client_id) {
        Ok(Some(c)) => c,
        Ok(None) => return html_bad_request(oauth_error_html(OAuthErrorKind::UnknownClient, None)),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if client.disabled_at.is_some() {
        return html_bad_request(oauth_error_html(OAuthErrorKind::DisabledClient, None));
    }

    // 5. redirect_uri must be on the client's allowlist.
    if !client.redirect_uris.iter().any(|u| u == &params.redirect_uri) {
        return html_bad_request(oauth_error_html(OAuthErrorKind::RedirectUriNotAllowed, None));
    }

    // 6. Scope must be subset of allowed.
    let requested_scopes: Vec<String> = params
        .scope
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    if !requested_scopes.iter().all(|s| allowed.contains(s.as_str())) {
        return html_bad_request(oauth_error_html(OAuthErrorKind::ScopeNotAllowed, None));
    }

    // 7. Check for an existing grant that pre-approves some/all scopes.
    let approved_grant = match state
        .store
        .grant_by_client_and_redirect(&params.client_id, &params.redirect_uri)
    {
        Ok(g) => g,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let previously_approved: HashSet<&str> = approved_grant
        .as_ref()
        .map(|g| g.scopes.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let pre_approved: Vec<String> = requested_scopes
        .iter()
        .filter(|s| previously_approved.contains(s.as_str()))
        .cloned()
        .collect();
    let all_pre_approved = approved_grant.is_some()
        && requested_scopes
            .iter()
            .all(|s| previously_approved.contains(s.as_str()));
    let patient_from_grant = approved_grant.and_then(|g| g.patient);

    // 8. Persist the pending authorization request.
    let request_id = Uuid::new_v4().to_string();
    let request = AuthorizationRequest::new_code_flow(NewCodeFlow {
        id: request_id.clone(),
        client_id: params.client_id.clone(),
        requested_scopes: requested_scopes.clone(),
        code_challenge: params.code_challenge.clone(),
        redirect_uri: params.redirect_uri.clone(),
        client_state: params.state.clone(),
        pre_approved_scopes: if pre_approved.is_empty() { None } else { Some(pre_approved) },
        ttl: AUTHORIZATION_REQUEST_TTL,
    });
    if state.store.insert_authorization_request(&request).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // 9. If all scopes are pre-approved, auto-issue the code and 302 to the client.
    if all_pre_approved {
        let code = Uuid::new_v4().to_string();
        let issued_at = Utc::now();
        let authorization_code = AuthorizationCode {
            code: code.clone(),
            request_id: request_id.clone(),
            client_id: params.client_id.clone(),
            redirect_uri: params.redirect_uri.clone(),
            code_challenge: params.code_challenge.clone(),
            granted_scopes: Json(requested_scopes.clone()),
            patient: patient_from_grant.clone(),
            issued_at,
            expires_at: issued_at + AUTHORIZATION_CODE_TTL,
        };
        if state.store.issue_authorization_code(&authorization_code).is_err()
            || state
                .store
                .approve_authorization_request(
                    &request_id,
                    &requested_scopes,
                    patient_from_grant.as_deref(),
                )
                .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let redirect_url = build_client_redirect_url(&params.redirect_uri, &code, &params.state);
        return Redirect::to(&redirect_url).into_response();
    }

    // 10. Otherwise redirect to the polling URL for the Owner UI to drive.
    let polling_url = page_paths::oauth_polling_url(&origin, &request_id);
    Redirect::to(&polling_url).into_response()
}

fn html_bad_request(html: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [("content-type", "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

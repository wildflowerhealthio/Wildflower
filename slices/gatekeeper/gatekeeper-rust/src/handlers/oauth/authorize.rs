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
use crate::extensions::AppState;
use crate::page_paths;
use crate::store::authorization_code::AuthorizationCode;
use crate::store::authorization_request::{AuthorizationRequest, NewCodeFlow};
use crate::store::types::Json;

/// Lifetime of an authorization_code from issuance to the client redeeming it
/// at `/token` (RFC 6749 §4.1.2 — "MUST be short lived").
const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// Lifetime of a pending authorization request waiting for Owner approval.
const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

/// Query parameters accepted at `/oauth/authorize` per RFC 6749 §4.1.1 +
/// RFC 7636 (PKCE).
#[derive(Debug, Deserialize)]
pub struct AuthorizeParams {
    pub code_challenge_method: String,
    pub client_id: String,
    pub scope: String,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
}

/// `GET /oauth/authorize` — validate the request, either auto-issue an
/// authorization code (when an existing grant pre-approves every requested
/// scope) or redirect the user-agent to the Owner UI to drive the approval.
pub async fn handle_authorize_request(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    Query(params): Query<AuthorizeParams>,
) -> Response {
    let origin = state.origin.origin_for(&headers);

    // Signing keys must exist — we have no token-mint capability otherwise.
    let signing_keys = match state.store.all_signing_keys() {
        Ok(k) => k,
        Err(e) => return internal_error("all_signing_keys lookup failed", e),
    };
    if signing_keys.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    if params.code_challenge_method != "S256" {
        return html_bad_request(oauth_error_html(
            OAuthErrorKind::UnsupportedCodeChallenge,
            Some(&params.code_challenge_method),
        ));
    }

    // redirect_uri must be a well-formed http/https URL.
    let parsed_redirect = match Url::parse(&params.redirect_uri) {
        Ok(u) => u,
        Err(_) => {
            return html_bad_request(oauth_error_html(OAuthErrorKind::InvalidRedirectUri, None))
        }
    };
    if parsed_redirect.scheme() != "http" && parsed_redirect.scheme() != "https" {
        return html_bad_request(oauth_error_html(OAuthErrorKind::InvalidScheme, None));
    }

    // Client must exist and be enabled.
    let client = match state.store.client_by_id(&params.client_id) {
        Ok(Some(c)) => c,
        Ok(None) => return html_bad_request(oauth_error_html(OAuthErrorKind::UnknownClient, None)),
        Err(e) => return internal_error("client_by_id lookup failed", e),
    };
    if client.disabled_at.is_some() {
        return html_bad_request(oauth_error_html(OAuthErrorKind::DisabledClient, None));
    }

    // redirect_uri must be on the client's allowlist (exact match).
    if !client
        .redirect_uris
        .iter()
        .any(|u| u == &params.redirect_uri)
    {
        return html_bad_request(oauth_error_html(
            OAuthErrorKind::RedirectUriNotAllowed,
            None,
        ));
    }

    // Requested scope must be a subset of the client's allowed scopes.
    let requested_scopes: Vec<String> = params
        .scope
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    if !requested_scopes
        .iter()
        .all(|s| allowed.contains(s.as_str()))
    {
        return html_bad_request(oauth_error_html(OAuthErrorKind::ScopeNotAllowed, None));
    }

    // Check for an existing grant that pre-approves some or all scopes for
    // this (client, redirect_uri) pair.
    let existing_grant = match state
        .store
        .grant_by_client_and_redirect(&params.client_id, &params.redirect_uri)
    {
        Ok(g) => g,
        Err(e) => return internal_error("grant_by_client_and_redirect lookup failed", e),
    };
    let previously_approved: HashSet<&str> = existing_grant
        .as_ref()
        .map(|g| g.scopes.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let pre_approved_scopes: Vec<String> = requested_scopes
        .iter()
        .filter(|s| previously_approved.contains(s.as_str()))
        .cloned()
        .collect();
    // Guard with `existing_grant.is_some()` so empty requested_scopes don't
    // satisfy `all()` vacuously when there's no grant.
    let all_scopes_pre_approved = existing_grant.is_some()
        && requested_scopes
            .iter()
            .all(|s| previously_approved.contains(s.as_str()));
    let patient_from_grant = existing_grant.and_then(|g| g.patient);

    // Persist the pending request — every path from here on out references
    // it by `request_id`.
    let request_id = Uuid::new_v4().to_string();
    let request = AuthorizationRequest::new_code_flow(NewCodeFlow {
        id: request_id.clone(),
        client_id: params.client_id.clone(),
        requested_scopes: requested_scopes.clone(),
        code_challenge: params.code_challenge.clone(),
        redirect_uri: params.redirect_uri.clone(),
        client_state: params.state.clone(),
        pre_approved_scopes: if pre_approved_scopes.is_empty() {
            None
        } else {
            Some(pre_approved_scopes)
        },
        ttl: AUTHORIZATION_REQUEST_TTL,
    });
    if let Err(e) = state.store.insert_authorization_request(&request) {
        return internal_error("insert_authorization_request failed", e);
    }

    // Fully-pre-approved fast path: skip the Owner UI and 302 the user-agent
    // straight back to the client with a fresh code.
    if all_scopes_pre_approved {
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
        if let Err(e) = state.store.issue_authorization_code(&authorization_code) {
            return internal_error("issue_authorization_code failed", e);
        }
        if let Err(e) = state.store.approve_authorization_request(
            &request_id,
            &requested_scopes,
            patient_from_grant.as_deref(),
        ) {
            return internal_error("approve_authorization_request failed", e);
        }
        let redirect_url = build_client_redirect_url(&parsed_redirect, &code, &params.state);
        return Redirect::to(&redirect_url).into_response();
    }

    // Otherwise redirect to the Owner UI's polling page so a human can approve.
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

fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

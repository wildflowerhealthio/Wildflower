use axum::extract::{Extension, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use chrono::{Duration, Utc};
use serde::Deserialize;
use std::collections::HashSet;
use url::Url;
use uuid::Uuid;

use super::shared::build_client_redirect_url;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, StartCodeAuthorizationArgs};
use crate::http::error_pages::{oauth_error_html, OAuthErrorKind};
use crate::http::origin::origin_for;
use crate::http::page_paths;
use crate::http::state::AppState;
use crate::db_utils::{JsonColumn, UriColumn};

/// Lifetime of an authorization_code from issuance to the client redeeming it
/// at `/token` (RFC 6749 §4.1.2 — "MUST be short lived").
const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// Lifetime of a pending authorization request waiting for Owner approval.
const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

/// Query parameters accepted at `/oauth/authorize` per RFC 6749 §4.1.1 +
/// RFC 7636 (PKCE). Stricter than the base spec: `state` is required (the
/// spec merely recommends it), and PKCE with S256 is mandatory — both
/// matching the OAuth 2.1 direction.
#[derive(Debug, Deserialize)]
pub struct AuthorizeParams {
    pub response_type: String,
    pub code_challenge_method: String,
    pub client_id: String,
    pub scope: String,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
}

/// `GET /oauth/authorize` — the authorization endpoint (RFC 6749 §3.1), the
/// public front door of the OAuth flow. Validates the request, then either
/// auto-issues an authorization code (when an existing grant pre-approves
/// every requested scope) or redirects the user-agent to the Owner UI to
/// drive the approval.
///
/// Nothing in-process calls this route. Registered clients (e.g.
/// SMART-on-FHIR apps) discover it via the FHIR server's
/// `.well-known/smart-configuration` (`authorization_endpoint`) and send the
/// *user's browser* here with PKCE params to start an authorization-code
/// flow:
///
/// 1. Browser lands here; the request is parked as an `AuthorizationRequest`
///    (5-minute TTL).
/// 2. Unless every requested scope is pre-approved by an existing grant for
///    this (client, redirect_uri) pair, the browser is 302'd to the Owner
///    UI's polling page, which polls `GET /oauth/authorize/{id}` (a custom
///    extension, not part of any RFC) until the Owner decides. RFC 6749
///    leaves the owner-interaction mechanism unspecified, so the polling
///    page is spec-legal; likewise §4.1 explicitly allows skipping consent
///    on a previously established authorization decision, which is what the
///    grant fast path implements.
/// 3. Approval 302s the browser back to the client's `redirect_uri` with
///    `code` + `state` (§4.1.2); the client then redeems the short-lived
///    code at `POST /oauth/token` (§4.1.3) with its PKCE verifier.
pub async fn handle_authorize_request(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    Query(params): Query<AuthorizeParams>,
) -> Response {
    let origin = origin_for(&headers);

    // Signing keys must exist — we have no token-mint capability otherwise.
    let signing_keys = match state.store.all_signing_keys() {
        Ok(k) => k,
        Err(e) => return internal_error("all_signing_keys lookup failed", e),
    };
    if signing_keys.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    // Only the authorization-code grant is implemented (RFC 6749 §4.1.1
    // makes response_type REQUIRED; `code` is its only supported value).
    if params.response_type != "code" {
        return html_bad_request(oauth_error_html(
            OAuthErrorKind::UnsupportedResponseType,
            Some(&params.response_type),
        ));
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

    // redirect_uri must be on the client's allowlist (exact match against the
    // already-parsed `Url` — both sides go through the same normalizer).
    if !client.redirect_uris.iter().any(|u| u == &parsed_redirect) {
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
        .grant_by_client_and_redirect(&params.client_id, &parsed_redirect)
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
    let request = AuthorizationRequest::new_code_authorization(StartCodeAuthorizationArgs {
        id: request_id.clone(),
        client_id: params.client_id.clone(),
        requested_scopes: requested_scopes.clone(),
        code_challenge: params.code_challenge.clone(),
        redirect_uri: parsed_redirect.clone(),
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
            redirect_uri: UriColumn(parsed_redirect.clone()),
            code_challenge: params.code_challenge.clone(),
            granted_scopes: JsonColumn(requested_scopes.clone()),
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

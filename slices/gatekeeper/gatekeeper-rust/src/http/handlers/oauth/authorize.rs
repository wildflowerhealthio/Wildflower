use axum::extract::{Extension, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use chrono::{Duration, Utc};
use serde::Deserialize;
use std::collections::HashSet;
use url::Url;
use uuid::Uuid;

use super::internal::build_client_redirect_url;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::db_utils::{JsonColumn, UriColumn};
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, StartCodeAuthorizationArgs};
use crate::domain::client::Client;
use crate::http::error_pages::{oauth_error_html, OAuthErrorKind};
use crate::http::page_paths;
use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;

/// A `code_challenge` for the S256 method is the base64url SHA-256 digest:
/// exactly 43 unpadded base64url characters (RFC 7636 §4.2).
const S256_CODE_CHALLENGE_LEN: usize = 43;

/// True when `s` is a syntactically valid S256 `code_challenge`: exactly 43
/// base64url characters (`[A-Za-z0-9-_]`, no padding) per RFC 7636 §4.2/§4.3.
/// RFC 7636's ABNF also lists `.` and `~`, but the SHA-256/base64url form the
/// only supported method (S256) produces never contains them.
fn is_valid_s256_code_challenge(s: &str) -> bool {
    s.len() == S256_CODE_CHALLENGE_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `302 Found` redirect. RFC 6749's examples use 302 and the TypeScript
/// implementation emits 302, so all `/oauth/authorize` redirects use it for
/// parity — axum's `Redirect` helpers only offer 303/307/308.
fn found_redirect(location: &str) -> Response {
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, location.to_string())],
    )
        .into_response()
}

/// Redirect a spec'd post-validation error back to the *validated*
/// `redirect_uri` with `error` and `state` query params (RFC 6749 §4.1.2.1).
/// Only callable once `redirect_uri` and `client_id` have been validated —
/// errors before that point must render a local page instead.
fn redirect_oauth_error(redirect_uri: &Url, error: &str, client_state: &str) -> Response {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("error", error)
        .append_pair("state", client_state);
    found_redirect(url.as_str())
}

/// Lifetime of an `authorization_code` from issuance to the client redeeming it
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

/// `GET /oauth/authorize` route.
pub(super) fn route() -> MethodRouter {
    get(handle_authorize_request)
}

/// The authorization endpoint (RFC 6749 §3.1), the public front door of the
/// OAuth flow. Validates the request, then either auto-issues an authorization
/// code (when an existing grant pre-approves every requested scope) or
/// redirects the user-agent to the Owner UI to drive the approval.
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
///    this (client, `redirect_uri`) pair, the browser is 302'd to the Owner
///    UI's polling page, which polls `GET /oauth/authorize/{id}` (a custom
///    extension, not part of any RFC) until the Owner decides. RFC 6749
///    leaves the owner-interaction mechanism unspecified, so the polling
///    page is spec-legal; likewise §4.1 explicitly allows skipping consent
///    on a previously established authorization decision, which is what the
///    grant fast path implements.
/// 3. Approval 302s the browser back to the client's `redirect_uri` with
///    `code` + `state` (§4.1.2); the client then redeems the short-lived
///    code at `POST /oauth/token` (§4.1.3) with its PKCE verifier.
async fn handle_authorize_request(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    Query(params): Query<AuthorizeParams>,
) -> Response {
    let origin = served_origin_for(&headers, &state.loopback_origin);

    // An active signing key must exist — without it we have no token-mint
    // capability. Probe presence directly rather than loading every key's
    // private material just to test emptiness; the mint path fetches
    // `active_signing_key()` anyway.
    match state.store.active_signing_key() {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Err(e) => return response_templates::internal_error("active_signing_key lookup failed", e),
    }

    // Validate in two phases: client/redirect_uri first (failures render a
    // local page), then the redirectable params (failures 302 back). Each
    // phase returns the values the rest of the flow needs or an error response.
    let client = match validate_and_load_client(&state, &params) {
        Ok(c) => c,
        Err(error_response) => return *error_response,
    };
    let parsed_redirect = match validate_redirect_url(&params, &client) {
        Ok(url) => url,
        Err(error_response) => return *error_response,
    };
    if let Err(error_response) = validate_code(&params, &parsed_redirect) {
        return *error_response;
    }
    let requested_scopes = match validate_requested_scopes(&params, &client, &parsed_redirect) {
        Ok(scopes) => scopes,
        Err(error_response) => return *error_response,
    };

    // Check for an existing grant that pre-approves some or all scopes for
    // this (client, redirect_uri) pair.
    let grant_coverage =
        match resolve_existing_grant_coverage(&state, &params, &parsed_redirect, &requested_scopes)
        {
            Ok(c) => c,
            Err(error_response) => return *error_response,
        };

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
        pre_approved_scopes: grant_coverage.pre_approved_scopes,
        ttl: AUTHORIZATION_REQUEST_TTL,
    });
    if let Err(e) = state.store.insert_authorization_request(&request) {
        return response_templates::internal_error("insert_authorization_request failed", e);
    }

    // Fully-pre-approved fast path: skip the Owner UI and 302 the user-agent
    // straight back to the client with a fresh code.
    if grant_coverage.all_scopes_pre_approved {
        let code = match issue_code(
            &state,
            &request_id,
            &params,
            &parsed_redirect,
            &requested_scopes,
            grant_coverage.patient.as_deref(),
        ) {
            Ok(code) => code,
            Err(error_response) => return *error_response,
        };
        return redirect_to_client(&parsed_redirect, &code, &params.state);
    }

    // Otherwise redirect to the Owner UI's polling page so a human can approve.
    let polling_url = page_paths::oauth_polling_url(&origin, &request_id);
    found_redirect(&polling_url)
}

/// Load the client and validate it exists and is enabled (RFC 6749 §4.1.2.1).
/// An unknown or disabled client can't be trusted as a redirect target, so the
/// failure renders a local HTML page rather than a redirect.
fn validate_and_load_client(
    state: &AppState,
    params: &AuthorizeParams,
) -> Result<Client, Box<Response>> {
    let client = match state.store.client_by_id(&params.client_id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Err(Box::new(html_bad_request(oauth_error_html(
                &OAuthErrorKind::UnknownClient,
            ))))
        }
        Err(e) => {
            return Err(Box::new(response_templates::internal_error(
                "client_by_id lookup failed",
                e,
            )))
        }
    };
    if client.disabled_at.is_some() {
        return Err(Box::new(html_bad_request(oauth_error_html(
            &OAuthErrorKind::DisabledClient,
        ))));
    }
    Ok(client)
}

/// Validate the `redirect_uri` against `client`: a well-formed http/https URL
/// (RFC 6749 §4.1.2.1) that is on the client's allowlist. A `redirect_uri` that
/// isn't trusted can't be used as a redirect target, so failures render a local
/// HTML page. Returns the parsed URL the redirect flow uses thereafter.
fn validate_redirect_url(params: &AuthorizeParams, client: &Client) -> Result<Url, Box<Response>> {
    let parsed_redirect = Url::parse(&params.redirect_uri).map_err(|_| {
        Box::new(html_bad_request(oauth_error_html(
            &OAuthErrorKind::InvalidRedirectUri,
        )))
    })?;
    if parsed_redirect.scheme() != "http" && parsed_redirect.scheme() != "https" {
        return Err(Box::new(html_bad_request(oauth_error_html(
            &OAuthErrorKind::InvalidScheme,
        ))));
    }
    // Exact match against the already-parsed `Url` — both sides go through the
    // same normalizer.
    if !client.redirect_uris.iter().any(|u| u == &parsed_redirect) {
        return Err(Box::new(html_bad_request(oauth_error_html(
            &OAuthErrorKind::RedirectUriNotAllowed,
        ))));
    }
    Ok(parsed_redirect)
}

/// Validate the response type and PKCE challenge. With `redirect_uri` +
/// `client_id` already validated, these spec'd errors go back to the client
/// per RFC 6749 §4.1.2.1 with `error` + `state`.
fn validate_code(params: &AuthorizeParams, parsed_redirect: &Url) -> Result<(), Box<Response>> {
    // Only the authorization-code grant is implemented; any other value is
    // `unsupported_response_type` (RFC 6749 §4.1.1 makes the parameter
    // REQUIRED, §4.1.2.1 names the error code).
    if params.response_type != "code" {
        return Err(Box::new(redirect_oauth_error(
            parsed_redirect,
            "unsupported_response_type",
            &params.state,
        )));
    }

    // Only S256 PKCE is supported. An unsupported `code_challenge_method` is
    // `invalid_request` (RFC 7636 §4.4.1).
    if params.code_challenge_method != "S256" {
        return Err(Box::new(redirect_oauth_error(
            parsed_redirect,
            "invalid_request",
            &params.state,
        )));
    }
    // The `code_challenge` must be a well-formed S256 challenge (RFC 7636
    // §4.3); a malformed one is `invalid_request` (RFC 7636 §4.4.1).
    if !is_valid_s256_code_challenge(&params.code_challenge) {
        return Err(Box::new(redirect_oauth_error(
            parsed_redirect,
            "invalid_request",
            &params.state,
        )));
    }

    Ok(())
}

/// Validate that every requested scope is on the client's allowlist
/// (`invalid_scope`, RFC 6749 §4.1.2.1). Returns the whitespace-split scopes.
fn validate_requested_scopes(
    params: &AuthorizeParams,
    client: &Client,
    parsed_redirect: &Url,
) -> Result<Vec<String>, Box<Response>> {
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
        return Err(Box::new(redirect_oauth_error(
            parsed_redirect,
            "invalid_scope",
            &params.state,
        )));
    }

    Ok(requested_scopes)
}

/// The subset of requested scopes an existing grant already covers, plus
/// whether *every* requested scope is covered (the fast-path trigger) and the
/// grant's patient context. All-empty when no grant exists for the pair.
struct ExistingGrantCoverage {
    pre_approved_scopes: Vec<String>,
    all_scopes_pre_approved: bool,
    patient: Option<String>,
}

impl ExistingGrantCoverage {
    /// Coverage when no grant exists: nothing pre-approved, no fast path.
    fn none() -> Self {
        ExistingGrantCoverage {
            pre_approved_scopes: Vec::new(),
            all_scopes_pre_approved: false,
            patient: None,
        }
    }
}

/// Look up an existing grant for this (client, `redirect_uri`) pair and compute
/// which requested scopes it already covers.
fn resolve_existing_grant_coverage(
    state: &AppState,
    params: &AuthorizeParams,
    parsed_redirect: &Url,
    requested_scopes: &[String],
) -> Result<ExistingGrantCoverage, Box<Response>> {
    let Some(existing_grant) = state
        .store
        .grant_by_client_and_redirect(&params.client_id, parsed_redirect)
        .map_err(|e| {
            Box::new(response_templates::internal_error(
                "grant_by_client_and_redirect lookup failed",
                e,
            ))
        })?
    else {
        return Ok(ExistingGrantCoverage::none());
    };

    let previously_approved: HashSet<&str> =
        existing_grant.scopes.iter().map(String::as_str).collect();
    let pre_approved_scopes: Vec<String> = requested_scopes
        .iter()
        .filter(|s| previously_approved.contains(s.as_str()))
        .cloned()
        .collect();
    let all_scopes_pre_approved = requested_scopes
        .iter()
        .all(|s| previously_approved.contains(s.as_str()));
    Ok(ExistingGrantCoverage {
        pre_approved_scopes,
        all_scopes_pre_approved,
        patient: existing_grant.patient,
    })
}

/// Mint a fresh authorization code, persist it, and mark the request approved
/// — the storage half of the fully-pre-approved fast path (RFC 6749 §4.1
/// permits skipping consent on a prior decision). Returns the issued `code`,
/// or an error `Response` if either store write fails.
fn issue_code(
    state: &AppState,
    request_id: &str,
    params: &AuthorizeParams,
    parsed_redirect: &Url,
    requested_scopes: &[String],
    patient: Option<&str>,
) -> Result<String, Box<Response>> {
    let code = generate_authorization_code();
    let issued_at = Utc::now();
    let authorization_code = AuthorizationCode {
        code: code.clone(),
        request_id: request_id.to_string(),
        client_id: params.client_id.clone(),
        redirect_uri: UriColumn(parsed_redirect.clone()),
        code_challenge: params.code_challenge.clone(),
        granted_scopes: JsonColumn(requested_scopes.to_vec()),
        patient: patient.map(str::to_string),
        issued_at,
        expires_at: issued_at + AUTHORIZATION_CODE_TTL,
    };
    state
        .store
        .issue_authorization_code(&authorization_code)
        .map_err(|e| {
            Box::new(response_templates::internal_error(
                "issue_authorization_code failed",
                e,
            ))
        })?;
    let approved = state
        .store
        .approve_authorization_request(request_id, requested_scopes, patient)
        .map_err(|e| {
            Box::new(response_templates::internal_error(
                "approve_authorization_request failed",
                e,
            ))
        })?;
    if !approved {
        // The request was just inserted as pending in this same handler, so a
        // non-pending row here is an unexpected concurrent transition.
        return Err(Box::new(response_templates::internal_error(
            "approve_authorization_request",
            "authorization request was not pending",
        )));
    }
    Ok(code)
}

/// 302 the user-agent back to the client's `redirect_uri` with `code` + `state`
/// (RFC 6749 §4.1.2).
fn redirect_to_client(parsed_redirect: &Url, code: &str, client_state: &str) -> Response {
    let redirect_url = build_client_redirect_url(parsed_redirect, code, client_state);
    found_redirect(&redirect_url)
}

fn html_bad_request(html: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [("content-type", "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

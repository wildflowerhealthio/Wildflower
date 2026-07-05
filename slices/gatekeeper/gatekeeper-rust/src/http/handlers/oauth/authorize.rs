use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use chrono::{Duration, Utc};
use serde::Deserialize;
use std::collections::HashSet;
use url::Url;
use utoipa::IntoParams;
use uuid::Uuid;

use super::error_codes::OAuthErrorCode;
use super::internal::{build_client_error_redirect_url, build_client_redirect_url};
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, StartCodeAuthorizationArgs};
use crate::domain::client::Client;
use crate::http::error_pages::{oauth_error_html, OAuthErrorKind};
use crate::http::page_paths;
use crate::http::response_templates::InternalError;
use crate::http::state::AppState;
use crate::http::ServedOrigin;
use persistence_rust::{JsonColumn, UriColumn};

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

/// Error half of the `/oauth/authorize` handler's `Result`. Each variant
/// renders one of the endpoint's three distinct failure shapes through
/// `IntoResponse`, so a fallible step bails with `?` instead of a `match` +
/// `return` at every call site — the authorization-endpoint analogue of
/// [`HandlerError`](crate::http::response_templates::HandlerError) and
/// [`TokenError`](super::internal::TokenError). Kept small (no embedded
/// `Response`) so `Result<_, AuthorizeError>` doesn't trip
/// `clippy::result_large_err`.
pub(super) enum AuthorizeError {
    /// Failure before `client_id` / `redirect_uri` are trusted (unknown or
    /// disabled client, malformed/un-allowlisted `redirect_uri`). Renders a
    /// local HTML page — redirecting to an unvalidated URI would be an open
    /// redirect (RFC 6749 §4.1.2.1).
    LocalPage(OAuthErrorKind),
    /// A spec'd error once `redirect_uri` is validated — 302 back to the
    /// client. Carries the already-built `Location` (the client `redirect_uri`
    /// merged with `error` + `state`, RFC 6749 §4.1.2.1) rather than the `Url`,
    /// keeping the variant small enough to dodge `clippy::result_large_err`.
    Redirect { location: String },
    /// No active signing key: without token-mint capability the endpoint can't
    /// proceed, so it 503s rather than parking a request it can never complete.
    ServiceUnavailable,
    /// A logged, opaque 500 (e.g. a store read failed) — see [`InternalError`].
    Internal(InternalError),
}

impl AuthorizeError {
    /// A spec'd post-validation error redirected back to the already-validated
    /// client `redirect_uri` (RFC 6749 §4.1.2.1). Builds the `Location` eagerly
    /// — only callable once `redirect_uri` + `client_id` are validated; errors
    /// before that point must render a local page instead.
    fn redirect(redirect_uri: &Url, error: OAuthErrorCode, client_state: &str) -> Self {
        AuthorizeError::Redirect {
            location: build_client_error_redirect_url(redirect_uri, error, client_state),
        }
    }

    /// A server-side failure: logs `source` against `context` and 500s opaquely.
    fn internal(context: &'static str, source: impl std::fmt::Display) -> Self {
        AuthorizeError::Internal(InternalError::new(context, source))
    }
}

impl IntoResponse for AuthorizeError {
    fn into_response(self) -> Response {
        match self {
            AuthorizeError::LocalPage(kind) => html_bad_request(oauth_error_html(&kind)),
            AuthorizeError::Redirect { location } => found_redirect(&location),
            AuthorizeError::ServiceUnavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            AuthorizeError::Internal(error) => error.into_response(),
        }
    }
}

/// Lifetime of an `authorization_code` from issuance to the client redeeming it
/// at `/token` (RFC 6749 §4.1.2 — "MUST be short lived").
const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// Lifetime of a pending authorization request waiting for Owner approval.
const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

/// Query parameters accepted at `/oauth/authorize` per RFC 6749 §4.1.1 +
/// RFC 7636 (PKCE). Stricter than the base spec: `state` is required (the
/// spec merely recommends it), and PKCE with S256 is mandatory — both
/// matching the OAuth 2.1 direction. The optional SMART App Launch extensions
/// (`launch`, `aud`) are documented on their fields below.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AuthorizeParams {
    pub response_type: String,
    pub code_challenge_method: String,
    pub client_id: String,
    pub scope: String,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
    /// SMART App Launch nonce, set by the EHR (apps-rust generates it,
    /// the SMART app forwards it). Not currently looked up against a
    /// launch-context table — we trust whatever value the SMART app
    /// echoes back and bind patient context at consent instead. Binding it
    /// (single-use, patient-bound) is tracked in
    /// <https://github.com/Assessment-is/Wildflower/issues/257>.
    #[serde(default)]
    pub launch: Option<String>,
    /// SMART App Launch audience hint: the FHIR base URL the SMART app
    /// expects to call with the resulting token. Not currently validated
    /// against [`shared_structures_rust::CANONICAL_ISSUER`] — `aud`
    /// binding in minted tokens is per-request via `served_origin_for`.
    /// Validating it is tracked in
    /// <https://github.com/Assessment-is/Wildflower/issues/257>.
    #[serde(default)]
    pub aud: Option<String>,
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
#[utoipa::path(
    get,
    path = "/authorize",
    params(AuthorizeParams),
    responses(
        (status = 302, description = "Redirect to the client redirect_uri or the owner approval UI"),
        (status = 400, description = "Local HTML error page (untrusted client / redirect_uri)"),
        (status = 503, description = "No active signing key")
    )
)]
pub(super) async fn handle_authorize_request(
    State(state): State<AppState>,
    origin: ServedOrigin,
    Query(params): Query<AuthorizeParams>,
) -> Result<Response, AuthorizeError> {
    ensure_active_signing_key(&state)?;

    // Log the SMART App Launch params (see the `launch` / `aud` field docs) so
    // an operator can correlate a SMART app's request back to the click that
    // triggered it.
    if params.launch.is_some() || params.aud.is_some() {
        tracing::info!(
            client_id = %params.client_id,
            launch = ?params.launch,
            aud = ?params.aud,
            "SMART App Launch parameters received at /oauth/authorize",
        );
    }

    // Validate in two phases: client/redirect_uri first (failures render a
    // local page), then the redirectable params (failures 302 back). Each
    // helper returns the values the rest of the flow needs or the matching
    // `AuthorizeError`.
    let client = validate_and_load_client(&state, &params)?;
    let parsed_redirect = validate_redirect_url(&params, &client)?;
    validate_code(&params, &parsed_redirect)?;
    let requested_scopes = validate_requested_scopes(&params, &client, &parsed_redirect)?;

    // Check for an existing grant that pre-approves some or all scopes for
    // this (client, redirect_uri) pair.
    let grant_coverage =
        resolve_existing_grant_coverage(&state, &params, &parsed_redirect, &requested_scopes)?;

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
    state
        .store
        .insert_authorization_request(&request)
        .map_err(|e| AuthorizeError::internal("insert_authorization_request failed", e))?;
    // `insert_authorization_request` opportunistically prunes every
    // row past its `expires_at`, including pending device-code rows.
    // Republish the head so the popup doesn't keep advertising a
    // device-code `user_code` whose backing row this code-flow insert
    // just swept out from under it.
    state.republish_active_device_user_code();

    // Fully-pre-approved fast path: skip the Owner UI and 302 the user-agent
    // straight back to the client with a fresh code.
    if grant_coverage.all_scopes_pre_approved {
        let code = issue_code(
            &state,
            &request_id,
            &params,
            &parsed_redirect,
            &requested_scopes,
            grant_coverage.patient.as_deref(),
        )?;
        return Ok(redirect_to_client(&parsed_redirect, &code, &params.state));
    }

    // Otherwise redirect to the Owner UI's polling page so a human can approve.
    let polling_url = page_paths::oauth_polling_url(&origin, &request_id);
    Ok(found_redirect(&polling_url))
}

/// Bail unless an active signing key exists — without token-mint capability the
/// endpoint can't issue codes, so it 503s up front rather than parking a
/// request it can never complete. Probes presence directly rather than loading
/// every key's private material; the mint path fetches `active_signing_key()`
/// anyway.
fn ensure_active_signing_key(state: &AppState) -> Result<(), AuthorizeError> {
    match state.store.has_active_signing_key() {
        Ok(true) => Ok(()),
        Ok(false) => Err(AuthorizeError::ServiceUnavailable),
        Err(e) => Err(AuthorizeError::internal(
            "has_active_signing_key probe failed",
            e,
        )),
    }
}

/// Load the client and validate it exists and is enabled (RFC 6749 §4.1.2.1).
/// An unknown or disabled client can't be trusted as a redirect target, so the
/// failure renders a local HTML page rather than a redirect.
fn validate_and_load_client(
    state: &AppState,
    params: &AuthorizeParams,
) -> Result<Client, AuthorizeError> {
    let client = match state.store.client_by_id(&params.client_id) {
        Ok(Some(c)) => c,
        Ok(None) => return Err(AuthorizeError::LocalPage(OAuthErrorKind::UnknownClient)),
        Err(e) => return Err(AuthorizeError::internal("client_by_id lookup failed", e)),
    };
    if client.disabled_at.is_some() {
        return Err(AuthorizeError::LocalPage(OAuthErrorKind::DisabledClient));
    }
    Ok(client)
}

/// Validate the `redirect_uri` against `client`: a well-formed http/https URL
/// (RFC 6749 §4.1.2.1) that is on the client's allowlist. A `redirect_uri` that
/// isn't trusted can't be used as a redirect target, so failures render a local
/// HTML page. Returns the parsed URL the redirect flow uses thereafter.
fn validate_redirect_url(params: &AuthorizeParams, client: &Client) -> Result<Url, AuthorizeError> {
    let parsed_redirect = Url::parse(&params.redirect_uri)
        .map_err(|_| AuthorizeError::LocalPage(OAuthErrorKind::InvalidRedirectUri))?;
    if parsed_redirect.scheme() != "http" && parsed_redirect.scheme() != "https" {
        return Err(AuthorizeError::LocalPage(OAuthErrorKind::InvalidScheme));
    }
    // Exact match against the already-parsed `Url` — both sides go through the
    // same normalizer.
    if !client.redirect_uris.iter().any(|u| u == &parsed_redirect) {
        return Err(AuthorizeError::LocalPage(
            OAuthErrorKind::RedirectUriNotAllowed,
        ));
    }
    Ok(parsed_redirect)
}

/// Validate the response type and PKCE challenge. With `redirect_uri` +
/// `client_id` already validated, these spec'd errors go back to the client
/// per RFC 6749 §4.1.2.1 with `error` + `state`.
fn validate_code(params: &AuthorizeParams, parsed_redirect: &Url) -> Result<(), AuthorizeError> {
    // Only the authorization-code grant is implemented; any other value is
    // `unsupported_response_type` (RFC 6749 §4.1.1 makes the parameter
    // REQUIRED, §4.1.2.1 names the error code).
    if params.response_type != "code" {
        return Err(AuthorizeError::redirect(
            parsed_redirect,
            OAuthErrorCode::UnsupportedResponseType,
            &params.state,
        ));
    }

    // Only S256 PKCE is supported. An unsupported `code_challenge_method` is
    // `invalid_request` (RFC 7636 §4.4.1).
    if params.code_challenge_method != "S256" {
        return Err(AuthorizeError::redirect(
            parsed_redirect,
            OAuthErrorCode::InvalidRequest,
            &params.state,
        ));
    }
    // The `code_challenge` must be a well-formed S256 challenge (RFC 7636
    // §4.3); a malformed one is `invalid_request` (RFC 7636 §4.4.1).
    if !is_valid_s256_code_challenge(&params.code_challenge) {
        return Err(AuthorizeError::redirect(
            parsed_redirect,
            OAuthErrorCode::InvalidRequest,
            &params.state,
        ));
    }

    Ok(())
}

/// Validate that every requested scope is on the client's allowlist
/// (`invalid_scope`, RFC 6749 §4.1.2.1). Returns the whitespace-split scopes.
fn validate_requested_scopes(
    params: &AuthorizeParams,
    client: &Client,
    parsed_redirect: &Url,
) -> Result<Vec<String>, AuthorizeError> {
    let requested_scopes: Vec<String> = params
        .scope
        .split_whitespace()
        .map(str::to_string)
        .collect();
    // Coverage-aware allowlist check, not exact string membership: a client
    // allowed a broad scope (e.g. `patient/*.rs`) also admits a narrower
    // same-grammar request it covers (`patient/Observation.r`). Coverage never
    // crosses the v1 word / v2 letter grammars — a registration in one grammar
    // authorizes requests in that grammar only. Mirrors the consent path's
    // `grantable_scopes`; the same intersection runs again there.
    if !requested_scopes.iter().all(|requested| {
        client
            .allowed_scopes
            .iter()
            .any(|allowed| scopes_rust::allowed_scope_covers(allowed, requested))
    }) {
        return Err(AuthorizeError::redirect(
            parsed_redirect,
            OAuthErrorCode::InvalidScope,
            &params.state,
        ));
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
) -> Result<ExistingGrantCoverage, AuthorizeError> {
    let Some(existing_grant) = state
        .store
        .grant_by_client_and_redirect(&params.client_id, parsed_redirect)
        .map_err(|e| AuthorizeError::internal("grant_by_client_and_redirect lookup failed", e))?
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
) -> Result<String, AuthorizeError> {
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
        .map_err(|e| AuthorizeError::internal("issue_authorization_code failed", e))?;
    let approved = state
        .store
        .approve_authorization_request(request_id, requested_scopes, patient)
        .map_err(|e| AuthorizeError::internal("approve_authorization_request failed", e))?;
    if !approved {
        // The request was just inserted as pending in this same handler, so a
        // non-pending row here is an unexpected concurrent transition.
        return Err(AuthorizeError::internal(
            "approve_authorization_request",
            "authorization request was not pending",
        ));
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
    (StatusCode::BAD_REQUEST, Html(html)).into_response()
}

use std::collections::HashSet;

use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use url::Url;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::db_utils::{DbResult, JsonColumn, UriColumn};
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::grant::Grant;
use crate::http::responses::{internal_error, not_found};
use crate::http::state::AppState;

/// Lifetime of the authorization_code minted when an Owner approves a
/// code-flow consent, from issuance to the client redeeming it at `/token`
/// (RFC 6749 §4.1.2 — "MUST be short lived"). Mirrors the fast-path TTL in
/// `authorize.rs`.
const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// A pending authorization-code consent request that has already passed the
/// loader's validation: it's `Pending`, an `AuthorizationCode` grant flow,
/// unexpired, and carries both a `redirect_uri` and a PKCE `code_challenge`.
/// Those two are unwrapped once here so handlers never re-prove them
/// (parse-don't-validate).
struct PendingCodeConsent {
    request: AuthorizationRequest,
    redirect_uri: Url,
    code_challenge: String,
}

/// Body returned to the Owner UI when it loads an authorization-code consent
/// prompt — describes the client, scopes, and any pre-approved subset.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConsent {
    pub id: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub redirect_uri: Url,
    pub pre_approved_scopes: Vec<String>,
    pub patient: Option<String>,
}

/// Body posted by the Owner UI to approve a consent prompt.
#[derive(Debug, Deserialize)]
pub struct ApproveBody {
    #[serde(rename = "approvedScopes")]
    pub approved_scopes: Vec<String>,
    pub patient: Option<String>,
}

/// Result the Owner UI sees after approving or denying a consent prompt.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConsentResult {
    Approved,
    Denied,
}

pub fn router() -> Router {
    Router::new()
        .route("/oauth-consents/{id}", get(get_consent))
        .route("/oauth-consents/{id}/approve", post(approve_consent))
        .route("/oauth-consents/{id}/deny", post(deny_consent))
}

async fn get_consent(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    let PendingCodeConsent {
        request,
        redirect_uri,
        ..
    } = match load_pending_authorization_code_request(&state, &id) {
        Ok(c) => c,
        Err(response) => return *response,
    };
    Json(OAuthConsent {
        id: id.clone(),
        client_id: request.client_id,
        scopes: request.requested_scopes.0,
        redirect_uri,
        pre_approved_scopes: request.pre_approved_scopes.into_inner(),
        patient: request.patient,
    })
    .into_response()
}

async fn approve_consent(
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
        Ok(None) => return not_found("OAuthConsentNotFound", "id", &id),
        Err(e) => return internal_error("client_by_id lookup failed", e),
    };
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes: Vec<String> = body
        .approved_scopes
        .into_iter()
        .filter(|s| requested.contains(s.as_str()) && allowed.contains(s.as_str()))
        .collect();
    if granted_scopes.is_empty() {
        // No requested-and-allowed scopes were approved — treat as a deny.
        if let Err(e) = state.store.deny_authorization_request(&id) {
            return internal_error("deny_authorization_request failed", e);
        }
        return Json(ConsentResult::Denied).into_response();
    }

    if let Err(e) =
        state
            .store
            .approve_authorization_request(&id, &granted_scopes, body.patient.as_deref())
    {
        return internal_error("approve_authorization_request failed", e);
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
        return internal_error("issue_authorization_code failed", e);
    }

    if let Err(e) = upsert_grant(
        &state,
        &request.client_id,
        &redirect_uri,
        &granted_scopes,
        body.patient.as_deref(),
    ) {
        return internal_error("upsert_grant failed", e);
    }
    Json(ConsentResult::Approved).into_response()
}

async fn deny_consent(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    if let Err(response) = load_pending_authorization_code_request(&state, &id) {
        return *response;
    }
    if let Err(e) = state.store.deny_authorization_request(&id) {
        return internal_error("deny_authorization_request failed", e);
    }
    Json(ConsentResult::Denied).into_response()
}

/// Load the authorization request for `id` and verify it's a pending,
/// unexpired authorization-code flow carrying both a `redirect_uri` and a
/// PKCE `code_challenge`. On success the two optional fields are unwrapped
/// into the returned [`PendingCodeConsent`] so callers never re-prove them
/// (parse-don't-validate). Returns a ready-to-use `Response` for both "not
/// found" and "internal error" outcomes so each handler can `match` once and
/// move on. A request whose `expires_at` has passed (AUTHORIZATION_REQUEST_TTL,
/// 5 min) is treated as not found — nothing actively transitions code-flow
/// requests to `Expired`, so the deadline is enforced here at read time.
fn load_pending_authorization_code_request(
    state: &AppState,
    id: &str,
) -> Result<PendingCodeConsent, Box<Response>> {
    let not_found_response = || Box::new(not_found("OAuthConsentNotFound", "id", id));
    match state.store.authorization_request_by_id(id) {
        Ok(Some(r))
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.expires_at > Utc::now() =>
        {
            // For a code-flow request both fields are populated by
            // `new_code_authorization`; if either is somehow absent the row is
            // malformed and we refuse it rather than panic.
            match (r.redirect_uri.clone(), r.code_challenge.clone()) {
                (Some(UriColumn(redirect_uri)), Some(code_challenge)) => Ok(PendingCodeConsent {
                    request: r,
                    redirect_uri,
                    code_challenge,
                }),
                _ => Err(not_found_response()),
            }
        }
        Ok(_) => Err(not_found_response()),
        Err(e) => Err(Box::new(internal_error(
            "authorization_request_by_id lookup failed",
            e,
        ))),
    }
}

fn upsert_grant(
    state: &AppState,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[String],
    patient: Option<&str>,
) -> DbResult<()> {
    let now = Utc::now();
    if let Some(existing) = state
        .store
        .grant_by_client_and_redirect(client_id, redirect_uri)?
    {
        // Union with the standing grant: consent is cumulative, so approving
        // a narrower request never un-approves scopes the Owner previously
        // consented to. (Revoking the grant is the way to withdraw consent.)
        let mut merged = existing.scopes.into_inner().clone();
        let additions: Vec<String> = scopes
            .iter()
            .filter(|s| !merged.contains(s))
            .cloned()
            .collect();
        merged.extend(additions);
        state
            .store
            .update_grant(&existing.id, &merged, now, patient)
    } else {
        let grant = Grant {
            id: Uuid::new_v4().to_string(),
            client_id: client_id.to_string(),
            scopes: JsonColumn(scopes.to_vec()),
            redirect_uri: UriColumn(redirect_uri.clone()),
            granted_at: now,
            last_used_at: None,
            patient: patient.map(str::to_string),
        };
        state.store.create_grant(&grant)
    }
}

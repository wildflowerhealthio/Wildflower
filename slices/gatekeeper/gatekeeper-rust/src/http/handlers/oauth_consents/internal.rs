//! Shared types and helpers for the `/oauth-consents/{id}` routes — the
//! request/response DTOs, the pending-request loader, and grant upsert. The
//! per-route handlers (`get`, `approve`, `deny`) live in sibling modules and
//! pull what they need from here.

use chrono::{Duration, Utc};
use serde::Serialize;
use url::Url;

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;
use persistence_rust::{DbResult, UriColumn};

/// Lifetime of the `authorization_code` minted when an Owner approves a
/// code-flow consent, from issuance to the client redeeming it at `/token`
/// (RFC 6749 §4.1.2 — "MUST be short lived"). Mirrors the fast-path TTL in
/// `authorize.rs`.
pub(super) const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// A pending authorization-code consent request that has already passed the
/// loader's validation: it's `Pending`, an `AuthorizationCode` grant flow,
/// unexpired, and carries both a `redirect_uri` and a PKCE `code_challenge`.
/// Those two are unwrapped once here so handlers never re-prove them
/// (parse-don't-validate).
pub(super) struct PendingCodeConsent {
    pub(super) request: AuthorizationRequest,
    pub(super) redirect_uri: Url,
    pub(super) code_challenge: String,
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

/// Load the authorization request for `id` and verify it's a pending,
/// unexpired authorization-code flow carrying both a `redirect_uri` and a
/// PKCE `code_challenge`. On success the two optional fields are unwrapped
/// into the returned [`PendingCodeConsent`] so callers never re-prove them
/// (parse-don't-validate). The error side is a [`HandlerError`] ("not found"
/// or "internal error"), so each handler can bail with `?` and move on. A
/// request whose `expires_at` has passed (`AUTHORIZATION_REQUEST_TTL`,
/// 5 min) is treated as not found — nothing actively transitions code-flow
/// requests to `Expired`, so the deadline is enforced here at read time.
pub(super) fn load_pending_authorization_code_request(
    state: &AppState,
    id: &str,
) -> Result<PendingCodeConsent, HandlerError> {
    let consent_not_found = || HandlerError::not_found("OAuthConsentNotFound", "id", id);
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
                _ => Err(consent_not_found()),
            }
        }
        Ok(_) => Err(consent_not_found()),
        Err(e) => Err(HandlerError::internal(
            "authorization_request_by_id lookup failed",
            e,
        )),
    }
}

pub(super) fn upsert_grant(
    state: &AppState,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[String],
    patient: Option<&str>,
) -> DbResult<()> {
    // The read-merge-write (scope union with any standing grant) now lives in a
    // single store transaction, paired with a UNIQUE index on
    // (client_id, redirect_uri), so two concurrent approvals can't each insert
    // a duplicate grant that would then survive revocation.
    state
        .store
        .upsert_grant(client_id, redirect_uri, scopes, patient, Utc::now())
}

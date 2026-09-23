use chrono::{DateTime, Duration, Utc};
use diesel::prelude::{Insertable, Queryable, Selectable};
use url::Url;

use crate::db::authorization_codes::authorization_codes;
use crate::db::shared::{JsonStrings, UrlText};
use crate::domain::authorization_request::AuthorizationRequest;

/// Lifetime of an `authorization_code`, from issuance (the `/authorize`
/// fast path or an Owner's consent approval) to the client redeeming it at
/// `/token` (RFC 6749 §4.1.2 — "MUST be short lived"). One value for both
/// mint sites so the two flows can't drift.
pub const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// A short-lived single-use authorization code as issued — the opaque `code`
/// plus everything it is bound to (client, redirect, PKCE challenge, granted
/// scopes, patient, expiry). Issued at `/authorize` or on an Owner's approval
/// and redeemed at `/token` (RFC 6749 §4.1.2). The PKCE `code_challenge` is
/// stashed here so the redeemer can prove possession of the matching
/// verifier. Diesel-mapped 1:1 to the `authorization_codes` table.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = authorization_codes)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct IssuedAuthorizationCode {
    /// Opaque single-use token the client presents at `/token` to redeem.
    pub code: String,
    /// `id` of the `AuthorizationRequest` this code was issued against.
    pub request_id: String,
    /// `client_id` the code was issued to; must match the redeemer at `/token`.
    pub client_id: String,
    /// Redirect URI the client used at `/authorize`; must exact-match the one supplied at `/token` (RFC 6749 §3.1.2.4).
    #[diesel(serialize_as = UrlText, deserialize_as = UrlText)]
    pub redirect_uri: Url,
    /// PKCE S256 challenge captured at `/authorize`; the redeemer must present a `code_verifier` that hashes to this.
    pub code_challenge: String,
    /// Scopes the user actually approved — may be a strict subset of what was requested.
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub granted_scopes: Vec<String>,
    /// SMART-on-FHIR patient context carried from the consent decision, if any.
    pub patient: Option<String>,
    /// When the code was minted.
    pub issued_at: DateTime<Utc>,
    /// Instant after which `/token` redemption is rejected as expired.
    pub expires_at: DateTime<Utc>,
}

/// A pending authorization-code request that is known to be well formed: it's
/// `Pending`, an `AuthorizationCode` grant flow, unexpired, and carries both a
/// `redirect_uri` and a PKCE `code_challenge`. Those two are unwrapped once so
/// callers never re-prove them (parse-don't-validate). It is what
/// [`RequestApprover::approve_for_code`](crate::domain::capabilities::writers::RequestApprover::approve_for_code)
/// approves.
///
/// Built by the consent flow's `load_pending_code_request` and
/// by the `/authorize` flow from the request it just parked — the sibling of
/// the [`IssuedAuthorizationCode`] it exists to mint, so it lives beside it
/// rather than in a file of its own.
#[derive(Debug, PartialEq)]
pub struct PendingCodeRequest {
    pub request: AuthorizationRequest,
    pub redirect_uri: Url,
    pub code_challenge: String,
}

impl PendingCodeRequest {
    /// Unwrap `request`'s code-flow fields, or `None` when it lacks a
    /// `redirect_uri` or a `code_challenge`. The caller has already checked the
    /// grant type, status, and expiry.
    #[must_use]
    pub fn from_request(request: AuthorizationRequest) -> Option<Self> {
        let redirect_uri = request.redirect_uri.clone()?;
        let code_challenge = request.code_challenge.clone()?;
        Some(PendingCodeRequest {
            request,
            redirect_uri,
            code_challenge,
        })
    }
}

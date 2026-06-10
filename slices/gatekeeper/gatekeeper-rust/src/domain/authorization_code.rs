use chrono::{DateTime, Utc};

use crate::db_utils::{JsonColumn, UriColumn};

/// A short-lived single-use authorization code issued at `/authorize` and
/// redeemed at `/token` (RFC 6749 §4.1.2). The PKCE `code_challenge` is
/// stashed here so the redeemer can prove possession of the matching
/// verifier.
#[derive(Debug, Clone)]
pub struct AuthorizationCode {
    /// Opaque single-use token the client presents at `/token` to redeem.
    pub code: String,
    /// `id` of the `AuthorizationRequest` this code was issued against.
    pub request_id: String,
    /// `client_id` the code was issued to; must match the redeemer at `/token`.
    pub client_id: String,
    /// Redirect URI the client used at `/authorize`; must exact-match the one supplied at `/token` (RFC 6749 §3.1.2.4).
    pub redirect_uri: UriColumn,
    /// PKCE S256 challenge captured at `/authorize`; the redeemer must present a `code_verifier` that hashes to this.
    pub code_challenge: String,
    /// Scopes the user actually approved — may be a strict subset of what was requested.
    pub granted_scopes: JsonColumn<Vec<String>>,
    /// SMART-on-FHIR patient context carried from the consent decision, if any.
    pub patient: Option<String>,
    /// When the code was minted.
    pub issued_at: DateTime<Utc>,
    /// Instant after which `/token` redemption is rejected as expired.
    pub expires_at: DateTime<Utc>,
}

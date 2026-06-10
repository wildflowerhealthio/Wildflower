use chrono::{DateTime, Utc};

use crate::json::Json;

/// A short-lived single-use authorization code issued at `/authorize` and
/// redeemed at `/token` (RFC 6749 §4.1.2). The PKCE `code_challenge` is
/// stashed here so the redeemer can prove possession of the matching
/// verifier.
#[derive(Debug, Clone)]
pub struct AuthorizationCode {
    pub code: String,
    pub request_id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub granted_scopes: Json<Vec<String>>,
    pub patient: Option<String>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

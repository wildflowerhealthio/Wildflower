//! The claims an access token carries: [`AccessTokenClaims`] as minted, and
//! [`VerifiedClaims`] as read back from a token that passed verification.

use chrono::serde::{ts_seconds, ts_seconds_option};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};

/// Normalize the `aud` claim — RFC 7519 lets it be a string or an array of
/// strings — into a single canonical `Vec<String>` so downstream code has one
/// shape to consume.
fn deserialize_audience<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    /// The two shapes RFC 7519 §4.1.3 allows `aud` to take.
    enum StringOrVec {
        /// A single audience, as a bare string.
        One(String),
        /// Several audiences, as an array.
        Many(Vec<String>),
    }
    match StringOrVec::deserialize(deserializer)? {
        StringOrVec::One(s) => Ok(vec![s]),
        StringOrVec::Many(v) => Ok(v),
    }
}

/// Claims encoded in an access token minted by the authorization server.
///
/// Field names are expanded for readability; serde renames them back to the
/// RFC 7519 short forms on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    /// The server's bare origin, which issued the token. A token another
    /// server minted is refused.
    #[serde(rename = "iss")]
    pub issuer: String,
    /// The `client_id` of the app the token was issued to. Revoking the app
    /// bumps this subject's epoch.
    #[serde(rename = "sub")]
    pub subject: String,
    /// Unique JWT ID (RFC 7519 §4.1.7) — a fresh random identifier stamped on
    /// every mint. It is the handle the token-revocation store keys a per-token
    /// denylist on, so a leaked token can be invalidated before its `exp`. Left
    /// as the wire short form `jti` (like `scope`/`patient`) since the name is
    /// itself the canonical spelling.
    pub jti: String,
    /// Resource server the token is intended for: the server's origin unless
    /// the request named another.
    #[serde(rename = "aud")]
    pub audience: String,
    /// Instant at which the token stops being valid.
    #[serde(rename = "exp", with = "ts_seconds")]
    pub expires_at: DateTime<Utc>,
    /// Instant at which the token was minted. Revoking the app refuses every
    /// token minted before that moment.
    #[serde(rename = "iat", with = "ts_seconds")]
    pub issued_at: DateTime<Utc>,
    /// Space-separated OAuth scopes granted by this token.
    pub scope: String,
    /// The SMART patient context, when the approval named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient: Option<String>,
    /// The browser session the token was minted under (the OpenID `sid`
    /// spelling), absent when there was none. Revoking that session revokes
    /// the token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
}

/// Claims successfully verified from an incoming JWT.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct VerifiedClaims {
    /// Origin that issued the token (`iss`).
    #[serde(rename = "iss")]
    pub issuer: String,
    /// `client_id` the token is bound to (`sub`).
    #[serde(rename = "sub")]
    pub subject: String,
    /// Unique JWT ID (`jti`), if the token carries one. Every token this
    /// server mints does; a token without one still verifies, but can't be
    /// denylisted individually (the per-subject epoch still covers it).
    #[serde(default)]
    pub jti: Option<String>,
    /// Audience(s) the token is intended for (`aud`). Normalized at parse time —
    /// a wire-level string is wrapped into a one-element vector.
    #[serde(rename = "aud", deserialize_with = "deserialize_audience")]
    pub audience: Vec<String>,
    /// Expiration instant, if present (`exp`).
    #[serde(rename = "exp", default, with = "ts_seconds_option")]
    pub expires_at: Option<DateTime<Utc>>,
    /// Time the token was minted, if present (`iat`).
    #[serde(rename = "iat", default, with = "ts_seconds_option")]
    pub issued_at: Option<DateTime<Utc>>,
    /// Space-separated scope list, if present.
    #[serde(default)]
    pub scope: Option<String>,
    /// SMART-on-FHIR patient context, if present.
    #[serde(default)]
    pub patient: Option<String>,
    /// The browser session the token was minted under (`sid`), if any.
    #[serde(default)]
    pub sid: Option<String>,
}

/// The caller's authority, read from the verified `scope` claim.
impl wildflowerhealthio_scope_capabilities::GrantedScopes for VerifiedClaims {
    /// Read the caller's authority from the verified `scope` claim so the shared
    /// `Scoped` extractor can coverage-check it. Delegates to the one shared
    /// claim-string → [`Grant`](wildflowerhealthio_scopes::Grant) parse, so this
    /// gate and a downstream slice's `ScopeClaims` gate can't disagree on how a
    /// claim becomes authority; a missing `scope` claim yields an empty grant
    /// (covers nothing) — fail-closed.
    fn granted(&self) -> wildflowerhealthio_scopes::Grant {
        wildflowerhealthio_scope_capabilities::grant_from_scope_claim(self.scope.as_deref())
    }
}

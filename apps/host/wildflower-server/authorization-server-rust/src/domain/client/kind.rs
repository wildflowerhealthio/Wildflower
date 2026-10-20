//! How a client authenticates ([`ClientKind`]) and which grants it may use at
//! `/token` ([`AllowedGrantType`]).

use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use serde::{Deserialize, Serialize};
use strum::{AsRefStr, Display, EnumString};

/// OAuth client authentication category (RFC 6749 §2.1) — `public` clients
/// can't keep a secret (e.g. SPAs, native), `confidential` ones can.
///
/// The wire string (stored in the `kind` column and serialized) is the
/// lowercased variant name: `Public` → `"public"`, `Confidential` →
/// `"confidential"`. `strum` derives the `&str` ↔ enum conversions
/// ([`AsRef<str>`], [`Display`], [`FromStr`](std::str::FromStr)) from the same
/// `serialize_all` rule the serde `rename_all` uses, so the two can't drift.
#[derive(
    Debug,
    Clone,
    Copy,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    EnumString,
    AsRefStr,
    Display,
    AsExpression,
    FromSqlRow,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum ClientKind {
    /// Can't keep a secret, so it authenticates by its `client_id` alone and
    /// proves possession with PKCE: a browser app or a native app.
    Public,
    /// Keeps a secret on a back end, and presents it at `/token` by Basic
    /// header or form body; its row stores the secret's argon2id hash.
    Confidential,
}

/// A grant type the token endpoint supports, used for the per-client
/// allow-list. Wire values match the `grant_type` parameter (RFC 6749 / RFC
/// 8628) so the stored JSON reads like the request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AllowedGrantType {
    /// Redeem an authorization code with its PKCE verifier (RFC 6749 §4.1.3).
    #[serde(rename = "authorization_code")]
    AuthorizationCode,
    /// Rotate a refresh token into a fresh access token and its successor
    /// (RFC 6749 §6).
    #[serde(rename = "refresh_token")]
    RefreshToken,
    /// Poll with a device code until the Owner decides (RFC 8628 §3.4).
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode,
}

impl AllowedGrantType {
    /// Every grant the token endpoint supports — the backward-compatible
    /// default for clients registered before per-client restrictions existed
    /// (and the value migration 007 backfills onto existing rows).
    pub const ALL: [AllowedGrantType; 3] = [
        AllowedGrantType::AuthorizationCode,
        AllowedGrantType::RefreshToken,
        AllowedGrantType::DeviceCode,
    ];
}

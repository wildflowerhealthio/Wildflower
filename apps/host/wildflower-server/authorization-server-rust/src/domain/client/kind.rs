//! How a client authenticates ([`ClientKind`]) and which grants it may use at
//! `/token` ([`AllowedGrantType`]).

use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use serde::{Deserialize, Serialize};
use strum::{AsRefStr, Display, EnumString};

/// OAuth client authentication category — `public` clients can't keep a secret (e.g. SPAs, native), `confidential` ones can.
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
    Public,
    Confidential,
}

/// A grant type the token endpoint supports, used for the per-client
/// allow-list. Wire values match the `grant_type` parameter (RFC 6749 / RFC
/// 8628) so the stored JSON reads like the request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AllowedGrantType {
    #[serde(rename = "authorization_code")]
    AuthorizationCode,
    #[serde(rename = "refresh_token")]
    RefreshToken,
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

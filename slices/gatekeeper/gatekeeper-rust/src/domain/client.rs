use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use strum::{AsRefStr, Display, EnumString};
use url::Url;

use persistence_rust::JsonColumn;

/// OAuth client authentication category — `public` clients can't keep a secret (e.g. SPAs, native), `confidential` ones can.
///
/// The wire string (stored in the `kind` column and serialized) is the
/// lowercased variant name: `Public` → `"public"`, `Confidential` →
/// `"confidential"`. `strum` derives the `&str` ↔ enum conversions
/// ([`AsRef<str>`], [`Display`], [`FromStr`](std::str::FromStr)) from the same
/// `serialize_all` rule the serde `rename_all` uses, so the two can't drift.
#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, EnumString, AsRefStr, Display,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
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

/// A registered OAuth client — the identity and policy bundle that `/authorize` and `/token` look up by `client_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    /// Primary key — the public client identifier the client supplies on every request.
    pub client_id: String,
    /// Human-readable label shown on the consent UI.
    pub name: String,
    /// Whether the client can keep a secret (`Confidential`) or not (`Public`).
    pub kind: ClientKind,
    /// Allowlist of redirect URIs; `/authorize` requires an exact match against this set.
    pub redirect_uris: JsonColumn<Vec<Url>>,
    /// Scopes the client is permitted to request; any scope outside this set is rejected.
    pub allowed_scopes: JsonColumn<Vec<String>>,
    /// Grant types the client may use at `/token`; a grant outside this set is
    /// rejected with `unauthorized_client` (RFC 6749 §5.2).
    pub allowed_grant_types: JsonColumn<Vec<AllowedGrantType>>,
    /// argon2id PHC string of the client secret for `Confidential` clients; `None` for `Public`.
    pub secret_hash: Option<String>,
    /// When the client was registered.
    pub registered_at: DateTime<Utc>,
    /// Set when the client has been disabled; `/authorize` and `/token` reject if `Some`.
    pub disabled_at: Option<DateTime<Utc>>,
}

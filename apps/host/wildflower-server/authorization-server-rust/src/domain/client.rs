use chrono::{DateTime, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use diesel::prelude::{Insertable, Queryable, Selectable};
use serde::{Deserialize, Serialize};
use strum::{AsRefStr, Display, EnumString};
use url::Url;

use crate::db::clients::{clients, JsonAllowedGrantTypes, JsonUrls};
use crate::db::shared::JsonStrings;

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

/// A registered OAuth client — the identity and policy bundle that `/authorize` and `/token` look up by `client_id`.
/// Diesel-mapped 1:1 to the `clients` table; the JSON list columns convert
/// through the column newtypes in [`crate::db::clients`] and
/// [`crate::db::shared`] at the bind/read boundary.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = clients)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Client {
    /// Primary key — the public client identifier the client supplies on every request.
    pub client_id: String,
    /// Human-readable label shown on the consent UI.
    pub name: String,
    /// Whether the client can keep a secret (`Confidential`) or not (`Public`).
    pub kind: ClientKind,
    /// Allowlist of absolute redirect URIs; `/authorize` requires an exact
    /// match against this set.
    #[diesel(serialize_as = JsonUrls, deserialize_as = JsonUrls)]
    pub redirect_uris: Vec<Url>,
    /// Scopes the client is permitted to request; any scope outside this set is rejected.
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub allowed_scopes: Vec<String>,
    /// Grant types the client may use at `/token`; a grant outside this set is
    /// rejected with `unauthorized_client` (RFC 6749 §5.2).
    #[diesel(serialize_as = JsonAllowedGrantTypes, deserialize_as = JsonAllowedGrantTypes)]
    pub allowed_grant_types: Vec<AllowedGrantType>,
    /// argon2id PHC string of the client secret for `Confidential` clients; `None` for `Public`.
    pub secret_hash: Option<String>,
    /// When the client was registered.
    pub registered_at: DateTime<Utc>,
    /// Set when the client has been disabled; `/authorize` and `/token` reject if `Some`.
    pub disabled_at: Option<DateTime<Utc>>,
}

impl Client {
    /// Whether every requested scope is inside this client's `allowed_scopes`.
    /// Coverage-aware ([`wildflowerhealthio_scopes::allowed_scope_covers`]), not exact
    /// membership: a client allowed a broad scope (`patient/*.rs`) also admits
    /// a narrower request it covers (`patient/Observation.r`). Read at
    /// `/authorize` (the first-party host) and `/device_authorization` (every
    /// client).
    #[must_use]
    pub fn allows_scopes(&self, requested: &[String]) -> bool {
        requested
            .iter()
            .all(|requested_scope| self.allows_scope(requested_scope))
    }

    /// Whether `redirect_uri` exactly equals an entry on this client's
    /// `redirect_uris` allowlist. This is the one allowlist verdict: both
    /// `/authorize` and the consent read path call it, so a prompt can never
    /// disagree with the endpoint that parked it.
    #[must_use]
    pub fn allows_redirect_uri(&self, redirect_uri: &Url) -> bool {
        self.redirect_uris.contains(redirect_uri)
    }

    /// Whether some entry of this client's `allowed_scopes` covers
    /// `requested_scope`.
    fn allows_scope(&self, requested_scope: &str) -> bool {
        self.allowed_scopes.iter().any(|allowed| {
            wildflowerhealthio_scopes::allowed_scope_covers(allowed, requested_scope)
        })
    }
}

#[cfg(test)]
mod allows_scopes_tests {
    use crate::domain::test_fake::{client, owned_scopes};

    /// Coverage, not spelling: a broad allowlist admits a narrower request it
    /// covers; a permission or context outside it is refused; an empty request
    /// is trivially allowed.
    #[test]
    fn allows_scopes_is_coverage_aware() {
        let client = client("app", &["patient/*.rs", "openid"]);
        assert!(client.allows_scopes(&owned_scopes(&["patient/Observation.r", "openid"])));
        assert!(client.allows_scopes(&[]));
        assert!(!client.allows_scopes(&owned_scopes(&["patient/Observation.c"])));
        assert!(!client.allows_scopes(&owned_scopes(&["system/*.r"])));
    }
}

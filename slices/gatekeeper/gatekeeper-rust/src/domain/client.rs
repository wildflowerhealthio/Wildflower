use chrono::{DateTime, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use diesel::prelude::{Insertable, Queryable, Selectable};
use serde::{Deserialize, Serialize};
use strum::{AsRefStr, Display, EnumString};
use url::Url;

use crate::db::clients::{clients, JsonAllowedGrantTypes, JsonRedirectUris};
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

/// One entry in a client's redirect-URI allowlist.
///
/// Most entries are [`Absolute`](Self::Absolute) URLs matched by exact equality.
/// A **self-hosted app**, though, is served from a different origin depending on
/// how it was launched — `http://127.0.0.1:<port>/` on the device,
/// `https://<subdomain>.<public_host>/` through the tunnel — and the tunnel
/// `public_host` isn't known when the client is seeded. Such an app registers an
/// [`AppRelative`](Self::AppRelative) entry: a leading-`/` path resolved against
/// the app's own origin **for the request's provenance** at `/authorize` time
/// (see `validate_redirect_url`), so one registration covers every launch origin
/// without ever naming a per-deployment host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisteredRedirectUri {
    /// A fully-qualified redirect URI, matched by exact URL equality.
    Absolute(Url),
    /// A path (a single leading `/`, never `//`) resolved against the
    /// self-hosted app's own origin at authorize time. Only a client that
    /// resolves to a self-hosted app (via the `SelfHostedRedirectResolver` seam)
    /// can use one; for any other client it resolves to nothing and matches no
    /// request.
    AppRelative(String),
}

impl RegisteredRedirectUri {
    /// Classify a stored allowlist string: a single leading `/` is an
    /// app-relative path; anything else must parse as an absolute URL. A `//…`
    /// (protocol-relative) string is neither a path we resolve nor a valid
    /// absolute URL, so it is rejected here as the most obvious origin-swap form.
    /// This prefix screen is *not* the authoritative same-origin guard, though —
    /// other joinable forms (`/\evil`, tab/newline) still classify as
    /// app-relative here, so `resolve_registered_redirect` re-checks that a
    /// resolved app-relative entry keeps the app's own origin.
    fn parse(raw: &str) -> Result<Self, url::ParseError> {
        if raw.starts_with('/') && !raw.starts_with("//") {
            Ok(RegisteredRedirectUri::AppRelative(raw.to_owned()))
        } else {
            Ok(RegisteredRedirectUri::Absolute(Url::parse(raw)?))
        }
    }

    /// The string form stored in the `redirect_uris` JSON column — the exact
    /// input [`parse`](Self::parse) round-trips.
    fn as_stored(&self) -> String {
        match self {
            RegisteredRedirectUri::Absolute(url) => url.to_string(),
            RegisteredRedirectUri::AppRelative(path) => path.clone(),
        }
    }

    /// The absolute URL when this entry is [`Absolute`](Self::Absolute); `None`
    /// for an app-relative entry.
    pub fn absolute(&self) -> Option<&Url> {
        match self {
            RegisteredRedirectUri::Absolute(url) => Some(url),
            RegisteredRedirectUri::AppRelative(_) => None,
        }
    }
}

impl From<Url> for RegisteredRedirectUri {
    fn from(url: Url) -> Self {
        RegisteredRedirectUri::Absolute(url)
    }
}

// Stored and read as a bare JSON string (`"https://app/cb"` or `"/"`), so the
// column stays an array of strings — backward-compatible with rows written
// before app-relative entries existed.
impl Serialize for RegisteredRedirectUri {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.as_stored())
    }
}

impl<'de> Deserialize<'de> for RegisteredRedirectUri {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        RegisteredRedirectUri::parse(&raw).map_err(serde::de::Error::custom)
    }
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
    /// Allowlist of redirect URIs; `/authorize` requires a match against this
    /// set (exact for [`Absolute`](RegisteredRedirectUri::Absolute) entries,
    /// provenance-resolved for [`AppRelative`](RegisteredRedirectUri::AppRelative)
    /// ones).
    #[diesel(serialize_as = JsonRedirectUris, deserialize_as = JsonRedirectUris)]
    pub redirect_uris: Vec<RegisteredRedirectUri>,
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

#[cfg(test)]
mod registered_redirect_uri_tests {
    use super::*;

    #[test]
    fn parse_classifies_absolute_and_relative() {
        assert_eq!(
            RegisteredRedirectUri::parse("/").unwrap(),
            RegisteredRedirectUri::AppRelative("/".to_owned())
        );
        assert_eq!(
            RegisteredRedirectUri::parse("/index.html").unwrap(),
            RegisteredRedirectUri::AppRelative("/index.html".to_owned())
        );
        assert_eq!(
            RegisteredRedirectUri::parse("https://app.example/cb").unwrap(),
            RegisteredRedirectUri::Absolute(Url::parse("https://app.example/cb").unwrap())
        );
        assert_eq!(
            RegisteredRedirectUri::parse("http://app.example/cb").unwrap(),
            RegisteredRedirectUri::Absolute(Url::parse("http://app.example/cb").unwrap())
        );
    }

    /// A protocol-relative `//host` string is neither a path we resolve nor a
    /// valid absolute URL, so it is rejected — it must never be joinable in a way
    /// that could swap the origin. A bare non-URL is rejected too.
    #[test]
    fn parse_rejects_protocol_relative_and_non_url() {
        assert!(RegisteredRedirectUri::parse("//evil.example").is_err());
        assert!(RegisteredRedirectUri::parse("not a url").is_err());
    }

    /// Both variants round-trip through the stored bare-string form (an array of
    /// strings in the column), so old absolute-only rows still decode.
    #[test]
    fn serde_round_trips_via_bare_string() {
        for raw in ["/", "/cb", "https://app.example/cb"] {
            let entry = RegisteredRedirectUri::parse(raw).unwrap();
            let json = serde_json::to_string(&entry).unwrap();
            assert_eq!(json, format!("\"{raw}\""));
            let back: RegisteredRedirectUri = serde_json::from_str(&json).unwrap();
            assert_eq!(back, entry);
        }
    }

    /// A protocol-relative entry is rejected at deserialize (the column decode
    /// path) too, so a tampered row surfaces as an error rather than a joinable
    /// origin-swapping redirect.
    #[test]
    fn deserialize_rejects_protocol_relative() {
        assert!(serde_json::from_str::<RegisteredRedirectUri>("\"//evil.example\"").is_err());
    }
}

impl Client {
    /// Whether every requested scope is inside this client's `allowed_scopes`.
    /// Coverage-aware ([`scopes_rust::allowed_scope_covers`]), not exact
    /// membership: a client allowed a broad scope (`patient/*.rs`) also admits
    /// a narrower request it covers (`patient/Observation.r`). Read at
    /// `/authorize` (the first-party host) and `/device_authorization` (every
    /// client).
    #[must_use]
    pub fn allows_scopes(&self, requested: &[String]) -> bool {
        requested.iter().all(|requested| {
            self.allowed_scopes
                .iter()
                .any(|allowed| scopes_rust::allowed_scope_covers(allowed, requested))
        })
    }
}

#[cfg(test)]
mod allows_scopes_tests {
    use crate::domain::test_fake::client;

    fn owned(scopes: &[&str]) -> Vec<String> {
        scopes.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Coverage, not spelling: a broad allowlist admits a narrower request it
    /// covers; a permission or context outside it is refused; an empty request
    /// is trivially allowed.
    #[test]
    fn allows_scopes_is_coverage_aware() {
        let client = client("app", &["patient/*.rs", "openid"]);
        assert!(client.allows_scopes(&owned(&["patient/Observation.r", "openid"])));
        assert!(client.allows_scopes(&[]));
        assert!(!client.allows_scopes(&owned(&["patient/Observation.c"])));
        assert!(!client.allows_scopes(&owned(&["system/*.r"])));
    }
}

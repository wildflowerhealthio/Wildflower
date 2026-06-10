use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::db_utils::JsonColumn;

/// OAuth client authentication category — `public` clients can't keep a secret (e.g. SPAs, native), `confidential` ones can.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    Public,
    Confidential,
}

impl From<&ClientKind> for &'static str {
    fn from(val: &ClientKind) -> Self {
        match val {
            ClientKind::Public => "public",
            ClientKind::Confidential => "confidential",
        }
    }
}

impl FromStr for ClientKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "public" => Ok(ClientKind::Public),
            "confidential" => Ok(ClientKind::Confidential),
            _ => Err(()),
        }
    }
}

/// A registered OAuth client — the identity and policy bundle that `/authorize` and `/token` look up by `client_id`.
#[derive(Debug, Clone)]
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
    /// SHA-256 hex of the client secret for `Confidential` clients; `None` for `Public`.
    pub secret_hash: Option<String>,
    /// When the client was registered.
    pub registered_at: DateTime<Utc>,
    /// Set when the client has been disabled; `/authorize` and `/token` reject if `Some`.
    pub disabled_at: Option<DateTime<Utc>>,
}

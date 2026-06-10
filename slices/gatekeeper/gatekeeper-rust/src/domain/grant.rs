use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::json::Json;

/// A previously-approved consent — when the same (client, redirect_uri) pair
/// re-authorizes, the gatekeeper can skip the consent prompt for any scopes
/// already in `scopes`.
#[derive(Debug, Clone, Serialize)]
pub struct Grant {
    pub id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub scopes: Json<Vec<String>>,
    #[serde(rename = "redirectUri")]
    pub redirect_uri: String,
    #[serde(rename = "grantedAt")]
    pub granted_at: DateTime<Utc>,
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<DateTime<Utc>>,
    pub patient: Option<String>,
}

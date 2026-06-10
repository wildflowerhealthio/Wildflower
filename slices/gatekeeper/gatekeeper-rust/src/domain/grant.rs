use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::db_utils::{JsonColumn, UriColumn};

/// A previously-approved consent — when the same (client, redirect_uri) pair
/// re-authorizes, the gatekeeper can skip the consent prompt for any scopes
/// already in `scopes`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// Primary key — internal UUID for the grant row.
    pub id: String,
    /// `client_id` the user approved this grant for.
    pub client_id: String,
    /// Scopes the user previously approved; future `/authorize` calls can skip the consent prompt for any subset of these.
    pub scopes: JsonColumn<Vec<String>>,
    /// The exact redirect URI this grant covers — `/authorize` keys grant lookup on `(client_id, redirect_uri)`.
    pub redirect_uri: UriColumn,
    /// When the user gave (or last re-confirmed) consent.
    pub granted_at: DateTime<Utc>,
    /// Last time `/authorize` used this grant to short-circuit the consent UI; `None` until first use.
    pub last_used_at: Option<DateTime<Utc>>,
    /// SMART-on-FHIR patient context recorded at approval, carried forward to future codes minted under this grant.
    pub patient: Option<String>,
}

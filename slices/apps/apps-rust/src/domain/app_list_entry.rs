//! `AppListEntry` — the wire shape for `GET /apps`. A projection of
//! [`AppEntry`] that **omits the launch `url`**: clients don't need it for
//! navigation (the launch endpoint is the only thing that resolves a URL,
//! and only at launch time), and omitting it sidesteps the apex-vs-subdomain
//! question for the catalogue entirely. Admin write responses
//! (`POST /apps`, `PATCH /apps/{id}`) keep [`AppEntry`] so the edited row
//! round-trips intact.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppEntry;

/// `GET /apps` row shape — id / enabled / name / optional subtitle /
/// `requires_tunnel`. No `url`. See the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppListEntry {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle: Option<String>,
    pub requires_tunnel: bool,
}

impl From<AppEntry> for AppListEntry {
    fn from(entry: AppEntry) -> Self {
        Self {
            id: entry.id,
            enabled: entry.enabled,
            name: entry.name,
            subtitle: entry.subtitle,
            requires_tunnel: entry.requires_tunnel,
        }
    }
}

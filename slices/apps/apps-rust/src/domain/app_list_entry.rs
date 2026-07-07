//! `AppListEntry` — the wire shape for `GET /apps`. Built from the parent
//! registry (`apps`) joined onto `cloud_apps` for `requires_tunnel`; **omits the
//! launch `url`** — read shapes carry no URL, see `docs/Apps/Explanation.md`.
//!
//! It carries the catalogue-display fields plus the per-row `provenance`,
//! `localOnly`, `smart`, `requiresTunnel`, and `removable` flags the homescreen
//! renders as badges / decides the launch vehicle + Remove control from. Admin
//! write responses
//! (`POST /apps`, `PATCH /apps/{id}`) keep [`AppEntry`](super::AppEntry) so the
//! edited cloud row round-trips intact.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::Provenance;

/// `GET /apps` row shape — the catalogue entry. No launch `url`. See the module
/// docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppListEntry {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle: Option<String>,
    /// How this app's launch target resolves; see [`Provenance`].
    pub provenance: Provenance,
    /// The declared no-egress flag (a homescreen badge this pass).
    pub local_only: bool,
    /// Whether this is a SMART app (the parent row carries a `client_id`).
    pub smart: bool,
    /// Whether a launch needs the tunnel up (cloud apps only; `false` for
    /// system / self-hosted).
    pub requires_tunnel: bool,
    /// Whether the owner can remove this app through the admin surface: `true`
    /// for cloud apps and for uploaded (non-seeded) self-hosted apps, `false`
    /// for system apps and the migration-seeded self-hosted apps. The editor's
    /// Remove control keys off this rather than re-deriving the rule per client.
    pub removable: bool,
}

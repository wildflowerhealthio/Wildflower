//! `App` — the parent registry row (`apps` table): the curated homescreen
//! entry shared by every kind. Field names match the column names so `sql_row!`
//! in the `db/` layer derives `TryFrom<&Row>` and the named-param array off the
//! same struct.
//!
//! It carries only the kind-independent fields. The launch target lives
//! elsewhere per [`provenance`](Provenance): a compiled-in
//! [`SystemApp`](super::SystemApp) source, a `self_hosted_apps` child (`port`),
//! or a `cloud_apps` child (`url`). `client_id` is a soft reference to the
//! gatekeeper `clients` table whose presence makes an app "smart" — see
//! `docs/Apps/Explanation.md` §"`client_id` is a soft reference".

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::Provenance;

/// One parent registry row, read by [`AppsStore::find_app`](crate::db::AppsStore)
/// for launch dispatch (provenance lookup) and the cloud-admin existence /
/// editability checks. The kind-specific launch fields live in the child tables /
/// the compiled-in source, keyed by `id`. Not itself a wire response shape —
/// `GET /apps` and `PUT /home-screen` speak [`AppListEntry`](super::AppListEntry)
/// — but it keeps the camelCase serde rename so a stored row round-trips cleanly
/// if ever serialized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// Stable id, globally unique across all kinds (the parent primary key, so
    /// there is no cross-table id collision to resolve).
    pub id: String,
    pub name: String,
    /// `None` means "no subtitle"; the wire serializes it as an absent field.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle: Option<String>,
    pub enabled: bool,
    /// Display order for `GET /apps` (`ORDER BY position`) and drag-to-reorder.
    pub position: i64,
    /// How this app's launch target resolves; see [`Provenance`].
    pub provenance: Provenance,
    /// The declared no-egress flag (a UI badge this pass).
    pub local_only: bool,
    /// Soft reference to a gatekeeper `clients.client_id`; `None` for non-SMART
    /// apps. Its presence is what [`Self::smart`] reports.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_id: Option<String>,
}

impl App {
    /// Whether this app is a SMART app — i.e. it carries a `client_id` soft
    /// reference to a gatekeeper OAuth client.
    #[must_use]
    pub fn smart(&self) -> bool {
        self.client_id.is_some()
    }
}

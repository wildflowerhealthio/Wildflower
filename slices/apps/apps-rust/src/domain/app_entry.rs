//! `AppEntry` — the **cloud app** wire shape: the create / update admin DTO and
//! the launch-side materialization of a `cloud_apps` child joined onto its
//! parent registry row. It is the only app shape that carries a launch `url`
//! (read shapes carry none — see `docs/Apps/Explanation.md`).
//!
//! Cloud apps are the only user-editable kind, so this shape is the cloud-admin
//! surface's request/response body. The `db/` layer builds it from the
//! `apps` + `cloud_apps` JOIN (hand-written, not `sql_row!`; see the
//! `db::cloud_apps` module).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::app_url::AppUrl;

/// One **cloud app** on the wire — the admin create/update DTO and the launch
/// handler's resolved shape.
///
/// The `url` is a template: `{origin}` is replaced with the served origin
/// at launch time, `{launch}` with a fresh per-launch nonce. A SMART-on-FHIR
/// app's URL might be
/// `https://example/launch.html?iss={origin}/fhir-r4&launch={launch}`; a
/// hand-rolled one might be `{origin}/some/path` or `https://other-host/x`.
/// See [`AppUrl`] for the accepted shapes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    /// The descriptive line shown under the app's name. `None` means the
    /// row has no explicit subtitle; the UI may fall back to the URL or
    /// render the row without one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle: Option<String>,
    /// The launch URL template, serialized as a plain string on the wire and
    /// in SQLite. See [`AppUrl`] for the accepted shapes / placeholders.
    #[schema(value_type = String)]
    pub url: AppUrl,
    pub requires_tunnel: bool,
}

//! `AppEntry` — the single shape used for an app on the wire AND in the
//! database. Field names match the SQL column names so `sql_row!` in the
//! `db/` layer can derive `TryFrom<&Row>` and the named-param array off the
//! same struct definition.
//!
//! Every app — whether shipped with the binary (seeded by the initial
//! migration) or added by the user — is the same shape and equally editable;
//! there is no provenance tag on the row.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::app_url::AppUrl;

/// One app as both the wire shape and the SQL row shape. Field names match
/// column names so `sql_row!` in `db/` can generate the mapping without a
/// separate row type.
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

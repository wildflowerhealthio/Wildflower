//! `AppEntry` — the single shape used for an app on the wire AND in the
//! database. Field names match the SQL column names so `sql_row!` in the
//! `db/` layer can derive `TryFrom<&Row>` and the named-param array off the
//! same struct definition.
//!
//! The `kind` field is a display-only hint: `bundled` rows shipped with
//! the binary (seeded by the initial migration), `custom` rows were added
//! by the user. Neither status restricts what can be edited — both
//! provenance tags are first-class editable apps post-install.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Provenance hint for a row. No behavioural effect — bundled rows are
/// just as editable as custom ones; the tag survives so the UI can label
/// a row "shipped with Wildflower" or offer a future "restore to default"
/// affordance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Bundled,
    Custom,
}

impl AppKind {
    /// The canonical string used in the SQL `kind` column and on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            AppKind::Bundled => "bundled",
            AppKind::Custom => "custom",
        }
    }
}

/// Returned by [`AppKind::from_str`] for a value that isn't one of the two
/// known variants. Surfaced as a `FromSql` error if a hand-edited DB row
/// carries a bogus `kind` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppKindParseError(pub String);

impl fmt::Display for AppKindParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown app kind: {}", self.0)
    }
}

impl std::error::Error for AppKindParseError {}

impl FromStr for AppKind {
    type Err = AppKindParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "bundled" => Ok(AppKind::Bundled),
            "custom" => Ok(AppKind::Custom),
            other => Err(AppKindParseError(other.to_owned())),
        }
    }
}

/// One app — bundled or custom — as both the wire shape and the SQL row
/// shape. Field names match column names so `sql_row!` in `db/` can
/// generate the mapping without a separate row type.
///
/// The `url` is a template: `{origin}` is replaced with the served origin
/// at launch time, `{launch}` with a fresh per-launch nonce. A bundled
/// SMART-on-FHIR app's URL might be
/// `https://example/launch.html?iss={origin}/fhir-r4&launch={launch}`; a
/// hand-rolled one might be `{origin}/some/path` or
/// `https://other-host/x`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub kind: AppKind,
    pub enabled: bool,
    pub name: String,
    /// The descriptive line shown under the app's name. `None` means the
    /// row has no explicit subtitle; the UI may fall back to the URL or
    /// render the row without one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle: Option<String>,
    pub url: String,
    pub requires_tunnel: bool,
}

//! The single wire shape for an app row in `GET /apps` and the admin
//! responses. Matches the TS `AppEntrySchema` shape verbatim so the existing
//! webview consumer doesn't need to learn a second contract.

use serde::Serialize;

/// What kind of app this row represents, as surfaced on the wire.
///
///   * `Bundled` — a code-defined static app shown verbatim from the registry.
///   * `Action`  — a code-defined no-op redirect (e.g. the FHIR Sharing toggle).
///   * `Custom`  — a user-defined entry with its own name + URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Bundled,
    Custom,
    Action,
}

/// One row of the apps catalogue as returned on the wire. `subtitle` is the
/// optional descriptive line shown under the app's name in the UI — bundled
/// apps always have one (their `subtitle` from the registry), custom apps
/// reuse their URL string as the subtitle and omit it when the URL is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(rename = "requiresTunnel")]
    pub requires_tunnel: bool,
    pub kind: AppKind,
    pub enabled: bool,
}

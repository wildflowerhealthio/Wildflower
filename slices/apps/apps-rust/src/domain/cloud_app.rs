//! `CloudApp` — the cloud kind payload on [`App`](super::App): the `cloud_apps`
//! child-table fields (the launch `url` template + `requires_tunnel`). The
//! catalogue fields (name / subtitle / enabled / …) live on the parent `App`.

use super::app_url::AppUrl;

/// The `cloud_apps` child payload. The `url` is a template: `{origin}` is
/// replaced with the served origin at launch time, `{launch}` with a fresh
/// per-launch nonce. See [`AppUrl`] for the accepted shapes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudApp {
    /// The launch URL template. See [`AppUrl`] for the accepted shapes /
    /// placeholders.
    pub url: AppUrl,
    /// Whether a launch must bring the tunnel up first (the app needs a public
    /// FHIR origin to call back into).
    pub requires_tunnel: bool,
}

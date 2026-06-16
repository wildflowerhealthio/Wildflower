//! The code-defined registry of bundled apps. The rows themselves are seeded
//! into SQLite by the initial migration so an enable/disable flag can persist
//! against them; the static metadata (display name, subtitle, the URL builder)
//! stays here in Rust because it isn't user-editable.
//!
//! Mirrors the TS `registry/bundled.ts` list. Keep the two in sync until the
//! TS slice's API consumer is retired in favour of this one.

use super::app_entry::AppKind;

/// A bundled-app's `kind`, narrower than the wire [`AppKind`] enum because
/// the registry never carries `custom`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundledKind {
    /// A standard bundled app — `LaunchApp` redirects to its computed URL.
    Bundled,
    /// A no-op action — `LaunchApp` redirects straight to the served origin
    /// (e.g. the FHIR Sharing toggle whose only effect is bringing the device
    /// up on the relay).
    Action,
}

impl From<BundledKind> for AppKind {
    fn from(kind: BundledKind) -> Self {
        match kind {
            BundledKind::Bundled => AppKind::Bundled,
            BundledKind::Action => AppKind::Action,
        }
    }
}

/// A static bundled app entry. `build_url` takes the served origin and a
/// freshly-minted launch nonce and returns the URL to redirect to.
#[derive(Debug, Clone, Copy)]
pub struct BundledApp {
    pub id: &'static str,
    pub name: &'static str,
    pub subtitle: &'static str,
    pub kind: BundledKind,
    pub requires_tunnel: bool,
    pub build_url: fn(origin: &str, launch: &str) -> String,
}

/// Special-cased id: the FHIR sharing action whose launch is always a 302 to
/// the served origin regardless of `kind` (matches the TS behaviour where
/// this id short-circuits the URL builder).
pub const FHIR_SHARING_ID: &str = "fhir-sharing";

/// The complete bundled registry. Order is the UI display order.
pub const BUNDLED_APPS: &[BundledApp] = &[
    BundledApp {
        id: FHIR_SHARING_ID,
        name: "FHIR Sharing",
        subtitle: "Open this device to FHIR requests from other apps.",
        kind: BundledKind::Action,
        requires_tunnel: true,
        build_url: |origin, _launch| origin.to_owned(),
    },
    BundledApp {
        id: "patient-browser",
        name: "Patient Browser",
        subtitle: "Browse patient records served from this device.",
        kind: BundledKind::Bundled,
        requires_tunnel: false,
        build_url: |origin, _launch| format!("{origin}/installed-apps/patient-browser/index.html"),
    },
    BundledApp {
        id: "api-view",
        name: "API View",
        subtitle: "View patient records in your browser.",
        kind: BundledKind::Bundled,
        requires_tunnel: false,
        build_url: |origin, _launch| {
            format!("{origin}/fhir-r4/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882")
        },
    },
    BundledApp {
        id: "api-docs",
        name: "API Docs",
        subtitle: "View API documentation in your browser.",
        kind: BundledKind::Bundled,
        requires_tunnel: false,
        build_url: |origin, _launch| format!("{origin}/docs"),
    },
    BundledApp {
        id: "growth-chart",
        name: "Growth Chart",
        subtitle: "Interactive growth chart app.",
        kind: BundledKind::Bundled,
        requires_tunnel: true,
        build_url: |origin, launch| {
            format!(
                "https://examples.smarthealthit.org/growth-chart-app/launch.html?iss={origin}/fhir-r4&launch={launch}"
            )
        },
    },
    BundledApp {
        id: "medication-viewer",
        name: "Medication Viewer",
        subtitle: "A bare medication viewer app.",
        kind: BundledKind::Bundled,
        requires_tunnel: true,
        build_url: |origin, launch| {
            format!(
                "https://mitre.github.io/smart-on-fhir-demo/launch.html?iss={origin}/fhir-r4&launch={launch}"
            )
        },
    },
];

/// Lookup a bundled app by id. `None` for a custom or unknown id.
pub fn find_bundled(id: &str) -> Option<&'static BundledApp> {
    BUNDLED_APPS.iter().find(|app| app.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The migration seeds every BUNDLED_APP id, so the registry's id list
    /// is the SQL seed's id list. Drift would mean a bundled app reading
    /// from the registry has no row to flip `enabled` on.
    #[test]
    fn registry_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for app in BUNDLED_APPS {
            assert!(seen.insert(app.id), "duplicate bundled id: {}", app.id);
        }
    }

    #[test]
    fn fhir_sharing_id_exists_and_is_an_action() {
        let app = find_bundled(FHIR_SHARING_ID).expect("FHIR sharing app must exist");
        assert_eq!(app.kind, BundledKind::Action);
    }
}

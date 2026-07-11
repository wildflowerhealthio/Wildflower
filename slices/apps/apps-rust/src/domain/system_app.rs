//! `SystemApp` — the compiled-in launch source + catalogue metadata for system
//! apps. A system app has **no stored table**: its id / name / subtitle /
//! `local_only` / launch URL all come from the [`SYSTEM_APPS`] list below, and a
//! `home_screen` row referencing its id is its only stored state. The store
//! folds these compiled-in entries into the catalogue for every `home_screen`
//! row whose id isn't a cloud or self-hosted row. The store tests pin that every
//! seeded `home_screen` system id resolves to a [`SYSTEM_APPS`] entry.
//!
//! Every system app is `{origin}`-relative (an on-device target served by this
//! host), so [`SystemApp::app_url`] always parses to
//! [`AppUrl::OriginRelative`](super::AppUrl::OriginRelative).

use super::{AppRecord, AppUrl};

/// One compiled-in system-app source. `'static` because the whole catalogue is
/// a `const` baked into the binary. A system app has no stored table — its
/// name / subtitle / launch URL live here, and a `home_screen` row referencing
/// its [`id`](Self::id) is its only stored state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemApp {
    /// Stable id — matches the seeded `home_screen` row's `app_id`.
    pub id: &'static str,
    pub name: &'static str,
    pub subtitle: Option<&'static str>,
    /// The launch URL template. Always `{origin}`-relative, so it parses to
    /// [`AppUrl::OriginRelative`](super::AppUrl::OriginRelative).
    pub url: &'static str,
    pub local_only: bool,
}

impl AppRecord for SystemApp {
    /// A system app is never a SMART app — it carries no `client_id`.
    fn smart(&self) -> bool {
        false
    }

    /// A system app is source-defined and never user-removable.
    fn removable(&self) -> bool {
        false
    }
}

impl SystemApp {
    /// Parse this source's `url` template into a validated
    /// [`AppUrl`]. Every entry is `{origin}`-relative, so this resolves to
    /// [`AppUrl::OriginRelative`](super::AppUrl::OriginRelative); the
    /// [`url_parses`](tests) test pins that every entry parses.
    ///
    /// # Errors
    ///
    /// Returns the [`AppUrlError`](super::AppUrlError) if a (compiled-in) entry's
    /// `url` doesn't parse — impossible for the shipped list, but surfaced as a
    /// typed error rather than a panic for the launch handler.
    pub fn app_url(&self) -> Result<AppUrl, super::AppUrlError> {
        self.url.parse()
    }
}

/// The compiled-in system-app catalogue. The seeded `home_screen` system ids
/// (migration `2026-07-11-000000`) must each resolve to an entry here (the store
/// tests assert the two agree).
pub const SYSTEM_APPS: &[SystemApp] = &[
    SystemApp {
        id: "api-view",
        name: "API View",
        subtitle: Some("View patient records in your browser."),
        url: "{origin}/fhir-r4/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882",
        local_only: true,
    },
    SystemApp {
        id: "api-docs",
        name: "API Docs",
        subtitle: Some("View API documentation in your browser."),
        url: "{origin}/docs",
        local_only: true,
    },
];

/// Look up a compiled-in system-app source by id. `None` when no entry matches
/// — the launch handler turns that into a typed error rather than panicking on
/// a seeded `system` row with no source.
#[must_use]
pub fn find(id: &str) -> Option<&'static SystemApp> {
    SYSTEM_APPS.iter().find(|app| app.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AppUrl;

    #[test]
    fn find_returns_a_known_source_and_none_otherwise() {
        assert_eq!(find("api-view").map(|s| s.id), Some("api-view"));
        assert!(find("no-such-system-app").is_none());
    }

    /// Every shipped entry parses to an origin-relative `AppUrl`.
    #[test]
    fn url_parses_to_origin_relative_for_every_entry() {
        for app in SYSTEM_APPS {
            let url = app.app_url().expect("compiled-in system url parses");
            assert!(
                matches!(url, AppUrl::OriginRelative(_)),
                "{} must be origin-relative, got {url:?}",
                app.id,
            );
        }
    }
}

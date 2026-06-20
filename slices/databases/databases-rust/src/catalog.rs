//! The fixed catalogue of host databases the data-management surface exposes.
//!
//! An incoming resource id is matched against this list before any filesystem
//! access, so the catalogue is both the source of truth for "which databases
//! exist" and the path-traversal guard — only these exact filenames ever join
//! onto the data directory.

/// One database the host exposes for export / delete. `id` doubles as the
/// on-disk filename and the REST resource id (e.g. `health-data.sqlite`), so it
/// must stay a bare filename with no path separators.
pub(crate) struct DatabaseDescriptor {
    /// Resource id == filename, e.g. `health-data.sqlite`.
    pub(crate) id: &'static str,
    /// Human label for the settings screen, e.g. `Health data`.
    pub(crate) label: &'static str,
    /// One-line description of what the database holds.
    pub(crate) description: &'static str,
}

/// Every catalogued database, in display order. Mirrors the two files the Tauri
/// host opens in `apps/wildflower-tauri/src-tauri/src/lib.rs`.
pub(crate) const CATALOG: &[DatabaseDescriptor] = &[
    DatabaseDescriptor {
        id: "health-data.sqlite",
        label: "Health data",
        description:
            "Your FHIR clinical records — patients, observations, and the rest of your chart.",
    },
    DatabaseDescriptor {
        id: "wildflower.sqlite",
        label: "Wildflower app data",
        description: "App state — access grants, tunnel settings, and the apps catalogue.",
    },
];

/// Resolve a resource id to its descriptor, or `None` for an unknown id. The
/// lookup is the path-traversal guard: a `../`-laden id never matches a
/// catalogue entry, so it never reaches the filesystem.
pub(crate) fn descriptor(id: &str) -> Option<&'static DatabaseDescriptor> {
    CATALOG.iter().find(|descriptor| descriptor.id == id)
}

//! Open-time configuration for the databases slice, mirroring
//! `apps-rust`'s `AppsConfig`. There is no shared `Connection` here — the slice
//! works at the file level, so it needs only the directory the databases live
//! in plus the host-supplied catalogue of which databases to expose.

use std::path::PathBuf;

/// One database the host exposes for export / delete. `id` doubles as the
/// on-disk filename and the REST resource id (e.g. `health-data.sqlite`), so it
/// must be a bare filename with no path separators. The host owns every field —
/// the slice has no built-in knowledge of which databases exist, so adding a new
/// one is a build-time change in the composing app alone.
#[derive(Debug, Clone)]
pub struct DatabaseDescriptor {
    /// Resource id == filename, e.g. `health-data.sqlite`.
    pub id: String,
    /// Human label for the settings screen, e.g. `Health data`.
    pub label: String,
    /// One-line, user-facing description of what the database holds.
    pub description: String,
}

/// What [`setup_databases`](crate::setup_databases) needs: the host's app-data
/// directory (the parent of every database file) and the catalogue of databases
/// to expose. The Tauri host passes `ServerRuntimeConfig::app_data_dir` and the
/// descriptors for the databases it opens.
#[derive(Debug, Clone)]
pub struct DatabasesConfig {
    /// The directory holding the database files — every resource id resolves to
    /// `data_dir.join(id)`.
    pub data_dir: PathBuf,
    /// The databases to expose, in display order. The host is the single source
    /// of truth; an id absent from this list is a `404`, which is also the
    /// path-traversal guard (only listed filenames ever reach the filesystem).
    pub databases: Vec<DatabaseDescriptor>,
}

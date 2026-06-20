//! Open-time configuration for the databases slice, mirroring
//! `apps-rust`'s `AppsConfig`. There is no shared `Connection` here — the slice
//! works at the file level, so it needs only the directory the databases live
//! in.

use std::path::PathBuf;

/// What [`setup_databases`](crate::setup_databases) needs: the host's app-data
/// directory, the parent of every catalogued database file
/// (`health-data.sqlite`, `wildflower.sqlite`). The Tauri host passes
/// `ServerRuntimeConfig::app_data_dir`.
#[derive(Debug, Clone)]
pub struct DatabasesConfig {
    /// The directory holding the host databases — every resource id resolves
    /// to `data_dir.join(id)`.
    pub data_dir: PathBuf,
}

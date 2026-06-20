//! `databases-rust` — the host-side data-management slice.
//!
//! A small, resource-focused HTTP surface over the host's SQLite databases.
//! Where the other `-rust` slices each own a store, this one is deliberately
//! storeless: it operates at the *file* level on databases that other slices
//! own (`health-data.sqlite` is managed by `emr-rust`, `wildflower.sqlite` by
//! the gatekeeper / tunnel / apps slices), so the host hands it only the data
//! directory.
//!
//! The slice has no built-in knowledge of which databases exist: the host
//! supplies the catalogue (id/label/description) via [`DatabasesConfig`], so
//! adding a new database is a build-time change in the composing app alone.
//! Matching an incoming id against that catalogue both resolves the file and
//! closes path traversal (only catalogued filenames ever reach the filesystem).
//!
//! Layered like `apps-rust` / `tunnel-rust`:
//!
//!  - [`config`] — the host-supplied [`DatabaseDescriptor`] catalogue.
//!  - [`metadata`] — the wire [`metadata::DatabaseMetadata`] (size, table
//!    count, modified time) the settings screen renders.
//!  - [`files`] — the file-level operations: a consistent export snapshot
//!    (`VACUUM INTO`) and an on-disk delete (main file plus journal sidecars).
//!  - [`http`] — the `/databases` wire contract.
//!
//! ## Surface
//!
//!  - `GET /databases` — metadata for every catalogued database.
//!  - `GET /databases/{id}` — download the database as a consistent SQLite
//!    snapshot (`application/vnd.sqlite3`).
//!  - `DELETE /databases/{id}` — delete the database file on disk.
//!
//! The router carries no middleware. The host wraps it with its own auth gate
//! (`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`) so the whole
//! surface is Owner-gated, mirroring the apps admin surface.

pub mod config;

mod files;
mod http;
mod metadata;

use std::sync::Arc;

use axum::Router;

pub use config::{DatabaseDescriptor, DatabasesConfig};
pub use http::DatabasesState;

/// Build the `/databases` router over the host's data directory, mirroring
/// `apps-rust`'s `setup_apps`. The host passes its app-data dir; the slice
/// resolves each catalogued database beneath it on demand.
///
/// The returned router carries no middleware — the consumer wraps it with its
/// own auth gate (the Tauri host applies the gatekeeper Owner check).
pub fn setup_databases(config: &DatabasesConfig) -> Router {
    let state = Arc::new(DatabasesState::new(
        config.data_dir.clone(),
        config.databases.clone(),
    ));
    http::router(state)
}

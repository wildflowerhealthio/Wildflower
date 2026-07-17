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
//!  - [`domain`] — the failure vocabulary ([`domain::DatabaseError`]), the wire
//!    metadata shape, the [`DatabaseFiles`](domain) port abstracting the
//!    filesystem/SQLite side-effects, the [`DatabasesState`] the router carries,
//!    and the scope-gated `capabilities`. Pure and `http`-free: it operates
//!    through the port, never `std::fs` directly, so it's stubbable in tests.
//!  - `fs` — the production [`DatabaseFiles`] adapter over the data directory,
//!    injected by [`setup_databases`].
//!  - [`files`] — the file-level primitives the adapter uses: a consistent export
//!    snapshot (`VACUUM INTO`) and an on-disk delete (main file plus journal
//!    sidecars).
//!  - [`http`] — the `/databases` wire contract.
//!
//! ## Surface
//!
//!  - `GET /databases` — metadata for every catalogued database.
//!  - `GET /databases/{id}` — download the database as a consistent SQLite
//!    snapshot (`application/vnd.sqlite3`), streamed off the async runtime.
//!  - `DELETE /databases/{id}` — schedule the database for deletion. The file
//!    is held open by the owning slice for the app's lifetime, so it can't be
//!    removed reliably at runtime; the delete drops a marker and the host calls
//!    [`purge_pending_deletions`] at startup (before opening any connection) to
//!    remove it. The settings UI tells the Owner to restart to finish.
//!
//! The router carries no middleware of its own. The host wraps it with the
//! gatekeeper bearer gate (`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`)
//! for authN; authZ is per-database: download/delete require the descriptor's
//! declared `read_scope`/`delete_scope` (see [`domain::capabilities`]), while the
//! metadata list is authenticated-only.

pub mod config;
pub mod domain;

mod files;
mod fs;
pub mod http;

use std::sync::Arc;

use axum::Router;

pub use config::{DatabaseDescriptor, DatabasesConfig};
pub use domain::DatabasesState;
pub use files::purge_pending_deletions;
pub use http::openapi_spec;

/// Build the `/databases` router over the host's data directory, mirroring
/// `apps-rust`'s `setup_apps`. The host passes its app-data dir; the slice
/// resolves each catalogued database beneath it on demand.
///
/// The returned router carries no middleware — the consumer wraps it with its
/// own authN gate (the Tauri host applies the gatekeeper bearer gate); the
/// per-database scope checks live inside the router's facades.
pub fn setup_databases(config: &DatabasesConfig) -> Router {
    let files = fs::filesystem_database_files(config.data_dir.clone());
    let state = Arc::new(DatabasesState::with_files(config.databases.clone(), files));
    http::router(state)
}

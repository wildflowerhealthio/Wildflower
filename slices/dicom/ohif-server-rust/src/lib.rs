pub(crate) mod domain;
pub(crate) mod hfs;
pub mod http;
pub(crate) mod live_bindings;

use std::sync::Arc;

use axum::Router;

use hfs::HfsDicomFileStore;
pub use http::openapi_spec;
pub use live_bindings::state::OhifServerState;

pub use domain::capabilities::grantable_ohif_server_scopes;

/// Build the OHIF server router. `hfs_router` is the HFS Axum router for
/// in-process delegation — the handler re-drives `GET /DocumentReference/{id}`
/// through it, decodes the attachment's base64 data, and serves the raw bytes.
///
/// The returned router carries no middleware, but every endpoint is scope-gated
/// (`user/DocumentReference.r` via `Scoped<LiveDicomFileReader>`). The consumer
/// MUST layer it with `gatekeeper_rust::gatekeeper_auth_middleware` — that gate
/// inserts the `ScopeClaims` the capability reads.
pub fn setup_ohif_server(hfs_router: Router) -> Router {
    let store = HfsDicomFileStore::new(hfs_router);
    http::router(Arc::new(OhifServerState::new(store)))
}

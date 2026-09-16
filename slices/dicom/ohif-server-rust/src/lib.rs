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

/// Build the OHIF server router. The consumer MUST layer it with
/// `gatekeeper_rust::gatekeeper_auth_middleware`.
pub fn setup_ohif_server(hfs_router: Router) -> Router {
    let store = HfsDicomFileStore::new(hfs_router);
    http::router(Arc::new(OhifServerState::new(store)))
}

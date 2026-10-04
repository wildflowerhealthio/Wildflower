//! The site's axum router: every route the relay serves on its local
//! hostnames.

use std::sync::Arc;

use shared_structures_rust::health_check::{health_router, AlwaysHealthy};

/// `GET /health`: `200 {"status":"pass"}` while the relay is up to answer.
pub(super) fn router() -> axum::Router {
    health_router(Arc::new(AlwaysHealthy))
}

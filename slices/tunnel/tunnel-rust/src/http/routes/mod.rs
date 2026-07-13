//! HTTP routes for the tunnel slice — the `/tunnel` GET + PUT surface, gathered
//! into one [`openapi_router`]. The served routes and the OpenAPI spec come from
//! the same `#[utoipa::path]`-annotated handlers.

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;

use crate::TunnelState;

mod tunnel;

pub(crate) fn openapi_router() -> OpenApiRouter<Arc<TunnelState>> {
    OpenApiRouter::new().merge(tunnel::openapi_router())
}

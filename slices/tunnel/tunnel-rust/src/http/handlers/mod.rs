use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;

use crate::TunnelState;

mod tunnel;

pub(crate) fn openapi_router() -> OpenApiRouter<Arc<TunnelState>> {
    OpenApiRouter::new().merge(tunnel::openapi_router())
}

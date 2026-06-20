//! HTTP handlers for the databases slice. One route table — `databases` —
//! mounted as an `OpenApiRouter` so the served routes and the OpenAPI spec come
//! from the same `#[utoipa::path]`-annotated handlers.

mod databases;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;

use crate::http::state::DatabasesState;

/// The `/databases` routes (`GET` list, `GET`/`DELETE` by id).
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<DatabasesState>> {
    databases::openapi_router()
}

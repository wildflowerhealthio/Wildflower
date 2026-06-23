//! HTTP handlers for the apps slice. Split into two route tables — `apps`
//! (public: list + launch) and `apps_admin` (write surface) — so the
//! consumer can wrap them with different middleware. Each table is an
//! `OpenApiRouter` so the served routes and the OpenAPI spec come from the
//! same `#[utoipa::path]`-annotated handlers.

mod apps;
mod apps_admin;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;

use crate::http::state::AppsState;

/// Public `/apps` routes (`GET /apps`, `POST /apps/{id}`).
pub(crate) fn public_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    apps::openapi_router()
}

/// Admin `/apps` routes (`POST /apps`, `PATCH`/`DELETE /apps/{id}`).
pub(crate) fn admin_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    apps_admin::openapi_router()
}

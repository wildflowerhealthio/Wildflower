//! Owner-scoped `/clients` management routes — list registered OAuth clients
//! and `PATCH` one's `disabledAt` to disable or re-enable it. One module per
//! route handler (`list_all`, `update_by_id`); `openapi_router()` is the only
//! path table.
//!
//! Unlike the rest of `/access`, these routes are **documented**: they're built
//! as an `OpenApiRouter` so the committed OpenAPI snapshot (and the TS drift
//! test against `authorization-core`) cover them. [`crate::http`] splits it — the
//! axum half is mounted under `/access` behind the session gate, the spec half
//! is nested under `/access` in the documented surface.

mod list_all;
mod update_by_id;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(list_all::handle_list_clients))
        .routes(routes!(update_by_id::handle_update_client))
}

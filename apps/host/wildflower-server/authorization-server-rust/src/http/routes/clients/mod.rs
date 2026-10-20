//! Owner-scoped `/clients` management routes — list registered OAuth clients
//! and `PATCH` one's `disabledAt` to disable or re-enable it. One module per
//! route handler (`list_all`, `update_by_id`); `openapi_router()` is the only
//! path table.
//!
//! Unlike the rest of `/authorization`, these routes are **documented**: they're built
//! as an `OpenApiRouter` so the committed OpenAPI snapshot (and the TS drift
//! test against `authorization-core`) cover them. [`crate::http`] splits it — the
//! axum half is mounted under `/authorization` behind the session gate, the spec half
//! is nested under `/authorization` in the documented surface.

/// `GET /clients`, and the [`ClientBody`](list_all::ClientBody) both
/// routes answer with.
mod list_all;
/// `PATCH /clients/{clientId}`.
mod update_by_id;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/clients` route table, as an `OpenApiRouter` so the spec is collected
/// from the routes that serve traffic.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(list_all::handle_list_clients))
        .routes(routes!(update_by_id::handle_update_client))
}

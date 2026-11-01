//! Owner-scoped `/grants` management routes — list, fetch, and revoke standing
//! client grants. One module per route handler (`list_all`, `get_by_id`,
//! `revoke_by_id`), each a documented handler; `openapi_router()` is the only
//! path table. The two methods on `/grants/{id}` (GET + DELETE) are merged here
//! onto the shared path.

/// `GET /grants/{id}`.
mod get_by_id;
/// `GET /grants`.
mod list_all;
/// `DELETE /grants/{id}`.
mod revoke_by_id;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/grants` route table, as an `OpenApiRouter` so the spec is collected
/// from the routes that serve traffic: `GET /grants` lists, and
/// `/grants/{id}` answers both `GET` and `DELETE`.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(list_all::handle_list_grants))
        .routes(routes!(
            get_by_id::handle_get_grant,
            revoke_by_id::handle_revoke_grant
        ))
}

//! Owner-scoped `/browser-sessions` routes — list the browsers the server has
//! signed in, and revoke one. One module per route handler (`list_all`,
//! `revoke_by_id`), each a documented handler; `openapi_router()` is the only
//! path table.

/// `GET /browser-sessions`, and the row body it answers with.
mod list_all;
/// `DELETE /browser-sessions/{sid}`.
mod revoke_by_id;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/browser-sessions` route table: the list, and the revoke by `sid`, as
/// an `OpenApiRouter` so the spec is collected from the routes that serve
/// traffic.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(list_all::handle_list_browser_sessions))
        .routes(routes!(revoke_by_id::handle_revoke_browser_session))
}

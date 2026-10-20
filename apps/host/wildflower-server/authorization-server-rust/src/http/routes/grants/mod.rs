//! Owner-scoped `/grants` management routes — list, fetch, and revoke standing
//! client grants. One module per route handler (`list_all`, `get_by_id`,
//! `revoke_by_id`), each exposing a `MethodRouter`; `router()` is the only path
//! table. The two methods on `/grants/{id}` (GET + DELETE) are merged here onto
//! the shared path.

/// `GET /grants/{id}`.
mod get_by_id;
/// `GET /grants`.
mod list_all;
/// `DELETE /grants/{id}`.
mod revoke_by_id;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AuthorizationServerState;

/// The `/grants` route table: `GET /grants` lists, and `/grants/{id}` answers
/// both `GET` and `DELETE`.
pub fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new().route("/grants", list_all::route()).route(
        "/grants/{id}",
        get_by_id::route().merge(revoke_by_id::route()),
    )
}

//! Owner-scoped `/browser-sessions` routes — list the browsers the server has
//! signed in, and revoke one. One module per route handler (`list_all`,
//! `revoke_by_id`), each exposing a `MethodRouter`; `router()` is the only
//! path table.

/// `GET /browser-sessions`, and the row body it answers with.
mod list_all;
/// `DELETE /browser-sessions/{sid}`.
mod revoke_by_id;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AuthorizationServerState;

/// The `/browser-sessions` route table: the list, and the revoke by `sid`.
pub fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new()
        .route("/browser-sessions", list_all::route())
        .route("/browser-sessions/{sid}", revoke_by_id::route())
}

//! `GET /authorization/grants/{id}`: one standing grant, for the Owner's view of
//! what an app or device holds.

use std::sync::Arc;

use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveGrantsReader;

/// The `GET` method on `/grants/{id}`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_get_grant)
}

/// `GET /authorization/grants/{id}` — one standing grant, or `404` when no
/// grant has the id. Through `Scoped<LiveGrantsReader>`
/// (`wildflower/Grant.r`).
async fn handle_get_grant(
    grants: Scoped<LiveGrantsReader>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AuthorizationServerError> {
    Ok(Json(grants.get(&id)?))
}

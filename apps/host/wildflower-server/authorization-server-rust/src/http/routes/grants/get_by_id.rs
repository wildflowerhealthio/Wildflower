use std::sync::Arc;

use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveGrantsReader;

/// `GET /grants/{id}` — fetch a single grant by id (scope `wildflower/Grant.r`).
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_get_grant)
}

async fn handle_get_grant(
    grants: Scoped<LiveGrantsReader>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AuthorizationServerError> {
    Ok(Json(grants.get(&id)?))
}

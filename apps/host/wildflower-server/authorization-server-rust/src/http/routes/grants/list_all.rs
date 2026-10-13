use std::sync::Arc;

use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveGrantsReader;

/// `GET /grants` — list every standing client grant for the launcher. Acquired
/// through [`LiveGrantsReader`] (scope `wildflower/Grant.r`): the read capability
/// *is* the extractor, so the scope check can't be skipped.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_list_grants)
}

async fn handle_list_grants(
    grants: Scoped<LiveGrantsReader>,
) -> Result<impl IntoResponse, AuthorizationServerError> {
    Ok(Json(grants.list()?))
}

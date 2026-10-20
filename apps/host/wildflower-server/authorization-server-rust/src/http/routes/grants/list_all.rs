use std::sync::Arc;

use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveGrantsReader;

/// The `GET` method on `/grants`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_list_grants)
}

/// `GET /authorization/grants` — every standing grant, of both kinds, in the
/// order they were granted: what each app or device has been allowed and
/// keeps. Acquired through [`LiveGrantsReader`] (scope `wildflower/Grant.r`):
/// the read capability *is* the extractor, so the scope check can't be
/// skipped.
async fn handle_list_grants(
    grants: Scoped<LiveGrantsReader>,
) -> Result<impl IntoResponse, AuthorizationServerError> {
    Ok(Json(grants.list()?))
}

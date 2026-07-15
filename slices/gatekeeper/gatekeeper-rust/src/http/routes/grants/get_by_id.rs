use std::sync::Arc;

use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::facades::GrantsReader;
use crate::http::scoped::Scoped;
use crate::http::state::GatekeeperState;

/// `GET /grants/{id}` — fetch a single grant by id (scope `wildflower/Grant.r`).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_get_grant)
}

async fn handle_get_grant(
    grants: Scoped<GrantsReader>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, GatekeeperError> {
    Ok(Json(grants.get(&id)?))
}

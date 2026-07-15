use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;

/// `GET /grants/{id}` — fetch a single grant by id.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_get_grant)
}

async fn handle_get_grant(
    State(state): State<Arc<GatekeeperState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, GatekeeperError> {
    let grant = actions::get_grant(&state.store, &id)?;
    Ok(Json(grant))
}

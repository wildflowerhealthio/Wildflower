use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::error::GatekeeperError;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;

/// `GET /grants/{id}` — fetch a single grant by id.
pub(super) fn route() -> MethodRouter<AppState> {
    get(handle_get_grant)
}

async fn handle_get_grant(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, HandlerError> {
    let grant = state
        .store
        .grant_by_id(&id)?
        .ok_or(GatekeeperError::GrantNotFound { id })?;
    Ok(Json(grant))
}

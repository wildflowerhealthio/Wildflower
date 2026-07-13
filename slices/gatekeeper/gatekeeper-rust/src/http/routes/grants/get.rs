use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::actions;
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
    let grant = actions::get_grant(&state.store, &id)?;
    Ok(Json(grant))
}

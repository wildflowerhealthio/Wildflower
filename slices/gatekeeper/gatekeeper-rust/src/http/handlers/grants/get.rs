use axum::extract::{Extension, Path};
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `GET /grants/{id}` — fetch a single grant by id.
pub(super) fn route() -> MethodRouter {
    get(handle_get_grant)
}

async fn handle_get_grant(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, HandlerError> {
    let grant = state
        .store
        .grant_by_id(&id)
        .map_err(|e| HandlerError::internal("grant_by_id lookup failed", e))?
        .ok_or_else(|| HandlerError::not_found("GrantNotFound", "id", &id))?;
    Ok(Json(grant))
}

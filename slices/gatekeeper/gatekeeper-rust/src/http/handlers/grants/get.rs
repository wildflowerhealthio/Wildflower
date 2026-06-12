use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::http::response_templates;
use crate::http::state::AppState;

/// `GET /grants/{id}` — fetch a single grant by id.
pub(super) fn route() -> MethodRouter {
    get(handle_get_grant)
}

async fn handle_get_grant(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Response {
    match state.store.grant_by_id(&id) {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => response_templates::not_found("GrantNotFound", "id", &id),
        Err(e) => response_templates::internal_error("grant_by_id lookup failed", e),
    }
}

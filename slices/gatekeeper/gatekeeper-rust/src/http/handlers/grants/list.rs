use axum::extract::Extension;
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `GET /grants` — list every standing client grant for the Owner UI.
pub(super) fn route() -> MethodRouter {
    get(handle_list_grants)
}

async fn handle_list_grants(
    Extension(state): Extension<AppState>,
) -> Result<impl IntoResponse, HandlerError> {
    let grants = state
        .store
        .all_grants()
        .map_err(|e| HandlerError::internal("all_grants lookup failed", e))?;
    Ok(Json(grants))
}

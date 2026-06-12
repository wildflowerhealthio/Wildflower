use axum::extract::Extension;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::http::response_templates;
use crate::http::state::AppState;

/// `GET /grants` — list every standing client grant for the Owner UI.
pub(super) fn route() -> MethodRouter {
    get(handle_list_grants)
}

async fn handle_list_grants(Extension(state): Extension<AppState>) -> Response {
    match state.store.all_grants() {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => response_templates::internal_error("all_grants lookup failed", e),
    }
}

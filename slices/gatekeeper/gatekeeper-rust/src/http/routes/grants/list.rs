use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;

/// `GET /grants` — list every standing client grant for the Owner UI.
pub(super) fn route() -> MethodRouter<AppState> {
    get(handle_list_grants)
}

async fn handle_list_grants(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, HandlerError> {
    let grants = actions::all_grants(&state.store)?;
    Ok(Json(grants))
}

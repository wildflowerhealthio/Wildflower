use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;

/// `GET /grants` — list every standing client grant for the Owner UI.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_list_grants)
}

async fn handle_list_grants(
    State(state): State<Arc<GatekeeperState>>,
) -> Result<impl IntoResponse, GatekeeperError> {
    let grants = actions::all_grants(&state.store)?;
    Ok(Json(grants))
}

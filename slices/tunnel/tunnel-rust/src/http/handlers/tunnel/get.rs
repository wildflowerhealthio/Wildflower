use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, MethodRouter};
use axum::Json;

use super::tunnel_state_response::TunnelStateResponse;
use crate::http::response_templates::HandlerError;
use crate::http::state::TunnelState;

/// `GET /tunnel` — read the current persisted settings + observed runtime as a
/// single wire snapshot.
pub(super) fn route() -> MethodRouter<Arc<TunnelState>> {
    get(handle_get_tunnel)
}

async fn handle_get_tunnel(
    State(state): State<Arc<TunnelState>>,
) -> Result<Json<TunnelStateResponse>, HandlerError> {
    let settings = state
        .store
        .get_settings()
        .map_err(|e| HandlerError::internal("get_settings lookup failed", e))?;
    Ok(Json(TunnelStateResponse::from_current_state(
        &state.daemon,
        &settings,
    )))
}

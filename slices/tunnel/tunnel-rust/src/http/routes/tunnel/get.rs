//! `GET /tunnel` — the current persisted settings + observed runtime snapshot.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use super::wire_representations::TunnelStateResponse;
use crate::domain::TunnelError;
use crate::http::state::TunnelState;

/// `GET /tunnel` — read the current persisted settings + observed runtime as a
/// single wire snapshot. Collected into the `OpenAPI` doc via `routes!` in the
/// parent module, which reads this `#[utoipa::path]`.
#[utoipa::path(
    get,
    tag = "Configuration",
    path = "/tunnel",
    responses(
        (status = 200, description = "Current tunnel settings + observed runtime", body = TunnelStateResponse)
    )
)]
pub(super) async fn handle_get_tunnel(
    State(state): State<Arc<TunnelState>>,
) -> Result<Json<TunnelStateResponse>, TunnelError> {
    // The store still returns its raw db error; wrap it into the domain
    // vocabulary at the call site (the store itself moves onto
    // `Result<_, TunnelError>` with the diesel migration).
    let settings = state
        .store
        .get_settings()
        .map_err(|e| TunnelError::backend("get_settings lookup failed", e))?;
    Ok(Json(TunnelStateResponse::from_current_state(
        &state.daemon,
        &settings,
    )))
}

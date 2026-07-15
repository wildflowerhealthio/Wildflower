use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::ConsentResult;

/// `POST /devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_deny_device_consent)
}

async fn handle_deny_device_consent(
    State(state): State<Arc<GatekeeperState>>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, GatekeeperError> {
    actions::deny_device_consent(&state.store, &state, &user_code)?;
    Ok(Json(ConsentResult::Denied))
}

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::http::errors::HandlerError;
use crate::http::routes::consent::deny_consent;
use crate::http::state::AppState;
use crate::http::wire_representations::ConsentResult;

/// `POST /devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_deny_device_consent)
}

async fn handle_deny_device_consent(
    State(state): State<AppState>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let device_request = actions::load_pending_device_request(&state.store, &user_code)?;
    deny_consent(&state, &device_request.id)
}

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::http::errors::HandlerError;
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
    actions::deny_device_consent(&state.store, &state, &user_code)?;
    Ok(Json(ConsentResult::Denied))
}

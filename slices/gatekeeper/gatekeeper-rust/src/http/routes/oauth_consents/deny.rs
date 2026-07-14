use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;
use crate::http::wire_representations::ConsentResult;

/// `POST /oauth-consents/{id}/deny` — the Owner declines a consent prompt.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_deny_oauth_consent)
}

async fn handle_deny_oauth_consent(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, HandlerError> {
    actions::deny_oauth_consent(&state.store, &state, &id)?;
    Ok(Json(ConsentResult::Denied))
}

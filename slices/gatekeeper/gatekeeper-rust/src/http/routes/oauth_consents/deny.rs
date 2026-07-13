use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::actions::load_pending_authorization_code_request;
use crate::http::errors::HandlerError;
use crate::http::routes::consent::deny_consent;
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
    load_pending_authorization_code_request(&state.store, &id)?;
    deny_consent(&state, &id)
}

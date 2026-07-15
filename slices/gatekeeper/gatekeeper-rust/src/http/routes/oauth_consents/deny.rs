use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::actions;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::ConsentResult;

/// `POST /oauth-consents/{id}/deny` — the Owner declines a consent prompt.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_deny_oauth_consent)
}

async fn handle_deny_oauth_consent(
    State(state): State<Arc<GatekeeperState>>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, GatekeeperError> {
    actions::deny_oauth_consent(&state.store, &state, &id)?;
    Ok(Json(ConsentResult::Denied))
}

use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::ConsentResult;
use crate::live_bindings::LiveConsentDecider;

/// `POST /oauth-consents/{id}/deny` — the Owner declines a consent prompt (scope
/// `wildflower/AuthorizationRequest.u`).
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_deny_oauth_consent)
}

async fn handle_deny_oauth_consent(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    consents.deny_oauth(&id)?;
    Ok(Json(ConsentResult::Denied))
}

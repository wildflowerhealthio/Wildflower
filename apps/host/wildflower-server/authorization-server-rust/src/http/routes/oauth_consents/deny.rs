use chrono::Utc;
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
/// `wildflower/AuthorizationRequest.u`). The answer carries the client callback
/// with `error=access_denied`, for the consent card to leave for.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_deny_oauth_consent)
}

async fn handle_deny_oauth_consent(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    Ok(Json(consents.deny_oauth_consent(&id, Utc::now())?.into()))
}

use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{post, MethodRouter};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveConsentRaiser;

/// `POST /oauth-consents/{id}/ask-owner` — a browser that can read a consent
/// prompt but not approve it hands it to the server's Owner (scope
/// `wildflower/AuthorizationRequest.r`, as reading it takes): the request no
/// longer counts as decidable in the browser that made it, so the host
/// notifies the Owner. Decides nothing; `204 No Content`, or `404` once the
/// request is no longer pending.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_ask_owner)
}

async fn handle_ask_owner(
    consents: Scoped<LiveConsentRaiser>,
    Path(id): Path<String>,
) -> Result<StatusCode, AuthorizationServerError> {
    consents.raise_for_owner(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

use chrono::Utc;
use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Extension;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{OwnerRaising, Scoped};
use crate::http::middleware::{start_limited_response, DeferredStartLimit};
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveConsentRaiser;

/// The `POST` method on `/oauth-consents/{id}/ask-owner`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_ask_owner)
}

/// `POST /authorization/oauth-consents/{id}/ask-owner` — a browser that can read a consent
/// prompt but not approve it hands it to the server's Owner (scope
/// `wildflower/AuthorizationRequest.r`, as reading it takes): the request no
/// longer counts as decidable in the browser that made it, so the host
/// notifies the Owner. Decides nothing. Raising a request spends from the
/// authorization start limit, as starting one the Owner is asked about does:
/// `429 Too Many Requests` when refused, the request left as it was. Raising
/// one already raised spends nothing. `204 No Content`, or `404` once the
/// request is no longer pending.
async fn handle_ask_owner(
    consents: Scoped<LiveConsentRaiser>,
    Extension(deferred_start_limit): Extension<DeferredStartLimit>,
    Path(id): Path<String>,
) -> Result<Response, AuthorizationServerError> {
    Ok(
        match consents.raise_for_owner(&id, || deferred_start_limit.admits(), Utc::now())? {
            OwnerRaising::Raised | OwnerRaising::AlreadyRaised => {
                StatusCode::NO_CONTENT.into_response()
            }
            OwnerRaising::StartLimited => start_limited_response(),
        },
    )
}

//! `POST /authorization/oauth-consents/{id}/ask-owner`: a browser that can't
//! decide its own request hands it to the Owner.

use chrono::Utc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{OwnerRaising, Scoped};
use crate::http::errors::OAuthConsentNotFoundBody;
use crate::http::middleware::{start_limited_response, DeferredStartLimit};
use crate::live_bindings::LiveConsentRaiser;

/// `POST /authorization/oauth-consents/{id}/ask-owner` — a browser that can read a consent
/// prompt but not approve it hands it to the server's Owner (scope
/// `wildflower/AuthorizationRequest.r`, as reading it takes): the request no
/// longer counts as decidable in the browser that made it, so the host
/// notifies the Owner. Decides nothing. Raising a request spends from the
/// authorization start limit, as starting one the Owner is asked about does:
/// `429 Too Many Requests` when refused, the request left as it was. Raising
/// one already raised spends nothing. `204 No Content`, or `404` once the
/// request is no longer pending.
#[utoipa::path(
    post,
    tag = "Owner consent",
    path = "/oauth-consents/{id}/ask-owner",
    params(("id" = String, Path, description = "The authorization request's id")),
    responses(
        (status = 204, description = "The request is raised for the Owner, by this call or an earlier one"),
        (status = 404, description = "No pending code-flow request has that id", body = OAuthConsentNotFoundBody),
        (status = 429, description = "The authorization start limit refused raising the request; it is left as it was"),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_ask_owner(
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

//! `POST /authorization/oauth-consents/{id}/deny`: the Owner declines an app's
//! request from its consent card.

use chrono::Utc;

use axum::extract::Path;
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::errors::OAuthConsentNotFoundBody;
use crate::http::wire_representations::ConsentResult;
use crate::live_bindings::LiveConsentDecider;

/// `POST /authorization/oauth-consents/{id}/deny` — the Owner declines a consent prompt (scope
/// `wildflower/AuthorizationRequest.u`). The answer carries the client callback
/// with `error=access_denied`, for the consent card to leave for.
#[utoipa::path(
    post,
    tag = "Owner consent",
    path = "/oauth-consents/{id}/deny",
    params(("id" = String, Path, description = "The authorization request's id")),
    responses(
        (status = 200, description = "The request is declined: `denied`, with the app's callback carrying `access_denied`", body = ConsentResult),
        (status = 404, description = "No pending code-flow request has that id", body = OAuthConsentNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_deny_oauth_consent(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    Ok(Json(consents.deny_oauth_consent(&id, Utc::now())?.into()))
}

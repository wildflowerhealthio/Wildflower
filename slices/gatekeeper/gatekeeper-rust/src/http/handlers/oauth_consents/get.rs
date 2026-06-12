use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use axum::Json;

use super::internal::{load_pending_authorization_code_request, OAuthConsent, PendingCodeConsent};
use crate::http::state::AppState;

/// `GET /oauth-consents/{id}` — load a pending authorization-code consent
/// prompt for the Owner UI to render.
pub(super) fn route() -> MethodRouter {
    get(handle_get_oauth_consent)
}

async fn handle_get_oauth_consent(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Response {
    let PendingCodeConsent {
        request,
        redirect_uri,
        ..
    } = match load_pending_authorization_code_request(&state, &id) {
        Ok(c) => c,
        Err(response) => return *response,
    };
    Json(OAuthConsent {
        id: id.clone(),
        client_id: request.client_id,
        scopes: request.requested_scopes.into_inner(),
        redirect_uri,
        pre_approved_scopes: request.pre_approved_scopes.into_inner(),
        patient: request.patient,
    })
    .into_response()
}

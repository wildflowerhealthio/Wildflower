use axum::extract::{Extension, Path};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::{load_pending_authorization_code_request, ConsentResult};
use crate::http::response_templates;
use crate::http::state::AppState;

/// `POST /oauth-consents/{id}/deny` — the Owner declines a consent prompt.
pub(super) fn route() -> MethodRouter {
    post(handle_deny_oauth_consent)
}

async fn handle_deny_oauth_consent(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = load_pending_authorization_code_request(&state, &id) {
        return *response;
    }
    if let Err(e) = state.store.deny_authorization_request(&id) {
        return response_templates::internal_error("deny_authorization_request failed", e);
    }
    Json(ConsentResult::Denied).into_response()
}

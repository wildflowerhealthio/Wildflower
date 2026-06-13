use axum::extract::{Extension, Path};
use axum::routing::{post, MethodRouter};
use axum::Json;

use super::internal::load_pending_authorization_code_request;
use crate::http::handlers::consent::{deny_consent, ConsentResult};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `POST /oauth-consents/{id}/deny` — the Owner declines a consent prompt.
pub(super) fn route() -> MethodRouter {
    post(handle_deny_oauth_consent)
}

async fn handle_deny_oauth_consent(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, HandlerError> {
    load_pending_authorization_code_request(&state, &id)?;
    deny_consent(&state, &id)
}

use axum::extract::{Path, State};
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::actions::{self, load_pending_authorization_code_request};
use crate::domain::PendingCodeConsent;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;
use crate::http::wire_representations::OAuthConsent;

/// `GET /oauth-consents/{id}` — load a pending authorization-code consent
/// prompt for the Owner UI to render.
pub(super) fn route() -> MethodRouter<AppState> {
    get(handle_get_oauth_consent)
}

async fn handle_get_oauth_consent(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<OAuthConsent>, HandlerError> {
    let PendingCodeConsent {
        request,
        redirect_uri,
        ..
    } = load_pending_authorization_code_request(&state.store, &id)?;
    let client_name = match actions::client_by_id(&state.store, &request.client_id) {
        Ok(Some(c)) => c.name,
        // Fall back to the raw client_id if lookup misses or fails — the UI
        // still works, the owner just sees less context.
        _ => request.client_id.clone(),
    };
    Ok(Json(OAuthConsent {
        id: id.clone(),
        client_id: request.client_id,
        client_name,
        scopes: request.requested_scopes,
        redirect_uri,
        pre_approved_scopes: request.pre_approved_scopes,
        patient: request.patient,
    }))
}

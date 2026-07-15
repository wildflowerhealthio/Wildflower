use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::domain::actions::{self, load_pending_authorization_code_request};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::PendingCodeConsent;
use crate::http::state::GatekeeperState;

/// Body returned to the Owner UI when it loads an authorization-code consent
/// prompt — describes the client, scopes, and any pre-approved subset. Local to
/// this one route (its only reader); the shapes two consent surfaces share live
/// in [`crate::http::wire_representations`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthConsent {
    pub(crate) id: String,
    pub(crate) client_id: String,
    /// The client's registered display name, so the consent UI can name the
    /// app instead of showing a raw `client_id`. Falls back to the
    /// `client_id` when the registration lookup misses.
    pub(crate) client_name: String,
    pub(crate) scopes: Vec<String>,
    pub(crate) redirect_uri: url::Url,
    pub(crate) pre_approved_scopes: Vec<String>,
    pub(crate) patient: Option<String>,
}

/// `GET /oauth-consents/{id}` — load a pending authorization-code consent
/// prompt for the Owner UI to render.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_get_oauth_consent)
}

async fn handle_get_oauth_consent(
    State(state): State<Arc<GatekeeperState>>,
    Path(id): Path<String>,
) -> Result<Json<OAuthConsent>, GatekeeperError> {
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

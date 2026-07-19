use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::domain::capabilities::{OAuthConsentView, Scoped};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;
use crate::live_bindings::LiveConsentReader;

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
/// prompt for the Owner UI to render (scope `wildflower/AuthorizationRequest.r`).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_get_oauth_consent)
}

async fn handle_get_oauth_consent(
    consents: Scoped<LiveConsentReader>,
    Path(id): Path<String>,
) -> Result<Json<OAuthConsent>, GatekeeperError> {
    let OAuthConsentView {
        request,
        redirect_uri,
        client_name,
    } = consents.oauth_consent(&id)?;
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

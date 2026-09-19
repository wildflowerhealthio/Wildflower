use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::capabilities::{OAuthConsentView, Scoped};
use crate::domain::client_registration::ClientRegistration;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;
use crate::http::ServedOrigin;
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
    /// How this request compares against the client's registration **right
    /// now** — the warning the consent UI leads with, and the flag that makes
    /// its acknowledgement checkbox mandatory.
    pub(crate) registration: ClientRegistrationBody,
}

/// Wire shape of [`OAuthConsent::registration`] — the
/// [`ClientRegistration`] verdict, `status`-tagged.
///
/// `{"status":"registered"}` for a request that matches the registration,
/// `{"status":"new"}` for a client this gatekeeper has never seen, and
/// `{"status":"changed","redirectUriIsNew":…,"newScopes":[…]}` when a known
/// client steps outside its registration.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ClientRegistrationBody {
    Registered,
    New,
    Changed {
        /// The presented `redirect_uri` is on no allowlist entry.
        #[serde(rename = "redirectUriIsNew")]
        redirect_uri_is_new: bool,
        /// The requested scopes the registration does not cover, in request
        /// order.
        #[serde(rename = "newScopes")]
        new_scopes: Vec<String>,
    },
}

/// Render the domain verdict onto the wire.
impl From<ClientRegistration> for ClientRegistrationBody {
    fn from(registration: ClientRegistration) -> Self {
        match registration {
            ClientRegistration::Registered => ClientRegistrationBody::Registered,
            ClientRegistration::New => ClientRegistrationBody::New,
            ClientRegistration::Changed {
                redirect_uri_is_new,
                new_scopes,
            } => ClientRegistrationBody::Changed {
                redirect_uri_is_new,
                new_scopes,
            },
        }
    }
}

/// `GET /oauth-consents/{id}` — load a pending authorization-code consent
/// prompt for the Owner UI to render (scope `wildflower/AuthorizationRequest.r`).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_get_oauth_consent)
}

async fn handle_get_oauth_consent(
    consents: Scoped<LiveConsentReader>,
    origin: ServedOrigin,
    Path(id): Path<String>,
) -> Result<Json<OAuthConsent>, GatekeeperError> {
    let OAuthConsentView {
        request,
        redirect_uri,
        client_name,
        registration,
    } = consents.oauth_consent(&id, &origin)?;
    Ok(Json(OAuthConsent {
        id: id.clone(),
        client_id: request.client_id,
        client_name,
        scopes: request.requested_scopes,
        redirect_uri,
        pre_approved_scopes: request.pre_approved_scopes,
        patient: request.patient,
        registration: registration.into(),
    }))
}

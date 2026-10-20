use chrono::Utc;
use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{OAuthConsentView, Scoped};
use crate::domain::client::presented_change::PresentedClientChange;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveConsentReader;

/// Body returned to the launcher when it loads an authorization-code consent
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
    /// The approval scopes the caller's own token lacks to approve this
    /// request (`wildflower/Grant.c`, and `wildflower/Client.c` or
    /// `wildflower/Client.u` when approving would register or widen the
    /// client). Empty when it may approve; otherwise the consent UI asks the
    /// server's Owner in place of Allow.
    pub(crate) missing_approval_scopes: Vec<String>,
}

/// Wire shape of [`OAuthConsent::registration`] — the
/// [`PresentedClientChange`], `status`-tagged.
///
/// `{"status":"registered"}` for a request that matches the registration,
/// `{"status":"new"}` for a client this authorization server has never seen, and
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

/// Render the domain change onto the wire.
impl From<PresentedClientChange> for ClientRegistrationBody {
    fn from(registration: PresentedClientChange) -> Self {
        match registration {
            PresentedClientChange::NoChange => ClientRegistrationBody::Registered,
            PresentedClientChange::WouldCreate => ClientRegistrationBody::New,
            PresentedClientChange::WouldWiden {
                redirect_uri_is_new,
                unregistered_requested_scopes: new_scopes,
            } => ClientRegistrationBody::Changed {
                redirect_uri_is_new,
                new_scopes,
            },
        }
    }
}

/// `GET /oauth-consents/{id}` — load a pending authorization-code consent
/// prompt for the launcher to render (scope `wildflower/AuthorizationRequest.r`).
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_get_oauth_consent)
}

async fn handle_get_oauth_consent(
    consents: Scoped<LiveConsentReader>,
    Path(id): Path<String>,
) -> Result<Json<OAuthConsent>, AuthorizationServerError> {
    let OAuthConsentView {
        pending_request,
        client_name,
        presented_client_change,
        missing_approval_scopes,
    } = consents.oauth_consent(&id, Utc::now())?;
    Ok(Json(OAuthConsent {
        id: id.clone(),
        patient: pending_request
            .state
            .approval()
            .and_then(|approval| approval.patient.clone()),
        client_id: pending_request.client_id,
        client_name,
        scopes: pending_request.requested_scopes,
        redirect_uri: pending_request.redirect_uri,
        pre_approved_scopes: pending_request.pre_approved_scopes,
        registration: presented_client_change.into(),
        missing_approval_scopes,
    }))
}

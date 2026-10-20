//! `GET /authorization/oauth-consents/{id}`: the consent card an app's request
//! is decided on, and the body it is drawn from.

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
    /// The request's id, which the card approves or denies by.
    pub(crate) id: String,
    /// The app's public `client_id`.
    pub(crate) client_id: String,
    /// The client's registered display name, so the consent UI can name the
    /// app instead of showing a raw `client_id`. Falls back to the
    /// `client_id` when the registration lookup misses.
    pub(crate) client_name: String,
    /// Everything the app asked for, in request order.
    pub(crate) scopes: Vec<String>,
    /// Where the app will be sent back to with the code.
    pub(crate) redirect_uri: url::Url,
    /// The requested scopes a standing grant already covers, ticked to start
    /// with.
    pub(crate) pre_approved_scopes: Vec<String>,
    /// The patient on the request's approval. A request the card can load is
    /// pending, so it carries no approval and this is `null`; the patient a
    /// SMART launch bound is not sent.
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
    /// The redirect is registered and every scope is covered: nothing new
    /// for the Owner to acknowledge.
    Registered,
    /// The Owner has never approved this app; nothing about it is stored
    /// until they do.
    New,
    /// The app is known, but the request steps outside its registration: a
    /// new redirect, new scopes, or both.
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

/// The domain change on the wire.
impl From<PresentedClientChange> for ClientRegistrationBody {
    /// Render the domain change onto the wire.
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

/// The `GET` method on `/oauth-consents/{id}`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_get_oauth_consent)
}

/// `GET /authorization/oauth-consents/{id}` — load a pending authorization-code consent
/// prompt for the launcher to render (scope `wildflower/AuthorizationRequest.r`).
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

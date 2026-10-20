//! `POST /authorization/oauth-consents/{id}/approve`: the Owner approves an app's
//! request from its consent card.

use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{ApproveOAuthConsentInput, Scoped};
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::ConsentResult;
use crate::live_bindings::LiveConsentDecider;

/// Body posted by the launcher to approve an authorization-code consent prompt.
///
/// Its own shape rather than the device flow's
/// [`ApproveBody`](crate::http::wire_representations::ApproveBody): only this
/// surface carries a registration warning, so only this body demands the
/// acknowledgement, and the device flow keeps no field it would always have to
/// send.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveOAuthConsentBody {
    /// The scopes the Owner ticked.
    pub(crate) approved_scopes: Vec<String>,
    /// Optional SMART-on-FHIR patient context to bind to the grant. When the
    /// request's SMART launch bound a patient, it must be that patient.
    pub(crate) patient: Option<String>,
    /// The Owner's acknowledgement that they recognise this app and its
    /// redirect address. Required (not defaulted) so a client that has not been
    /// updated to show the warning cannot approve a `new` or `changed` prompt by
    /// omission; it is ignored when the prompt carries no warning.
    pub(crate) acknowledged_registration_change: bool,
}

/// The `POST` method on `/oauth-consents/{id}/approve`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_approve_oauth_consent)
}

/// `POST /authorization/oauth-consents/{id}/approve` — the Owner approves a
/// consent prompt, granting a (narrowed) scope set and minting the authorization code the
/// polling endpoint hands back to the client. Gated by [`LiveConsentDecider`]
/// (scope `wildflower/AuthorizationRequest.u`), which also carries the approver's
/// own scopes: an approval delegating a resource scope beyond them is rejected
/// with a `403`. Approving a prompt whose client, redirect, or scopes are
/// outside the current registration without
/// [`acknowledged_registration_change`](ApproveOAuthConsentBody::acknowledged_registration_change)
/// is rejected with a `409` and writes nothing, as is an approval naming a
/// patient other than the one the request's SMART launch binds. The write
/// scope lives in the consent capability's `approve_oauth_consent`.
///
/// The answers:
///
/// - `200`, `"status":"approved"`: the code is issued; `redirect` is the
///   app's callback carrying it and the app's `state`, for the card to leave
///   for.
/// - `200`, `"status":"denied"`: nothing was granted, the requesting
///   browser's session has ended, or the app was disabled since; the request
///   is denied and `redirect` carries `access_denied`.
/// - `403`: the approver lacks an approval scope, or a ticked resource scope
///   is beyond their own grant. Nothing is written.
/// - `409`: the registration change wasn't acknowledged, or the body names a
///   patient other than the one the launch bound. Nothing is written.
/// - `404`: no live code-flow prompt has this id.
async fn handle_approve_oauth_consent(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
    Json(body): Json<ApproveOAuthConsentBody>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    let outcome = consents.approve_oauth_consent(
        &id,
        ApproveOAuthConsentInput {
            owner_approved_scopes: body.approved_scopes,
            patient: body.patient,
            acknowledged_registration_change: body.acknowledged_registration_change,
        },
        generate_authorization_code,
        Utc::now(),
    )?;
    Ok(Json(outcome.into()))
}

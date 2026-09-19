use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::capabilities::{ApproveOAuthConsentInput, Scoped};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::ConsentResult;
use crate::http::ServedOrigin;
use crate::live_bindings::LiveConsentDecider;

/// Body posted by the Owner UI to approve an authorization-code consent prompt.
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
    /// Optional SMART-on-FHIR patient context to bind to the grant.
    pub(crate) patient: Option<String>,
    /// The Owner's acknowledgement that they recognise this app and its
    /// redirect address. Required (not defaulted) so a client that has not been
    /// updated to show the warning cannot approve a `new` or `changed` prompt by
    /// omission; it is ignored when the prompt carries no warning.
    pub(crate) acknowledged_registration: bool,
}

/// `POST /oauth-consents/{id}/approve` — the Owner approves a consent prompt,
/// granting a (narrowed) scope set and minting the authorization code the
/// polling endpoint hands back to the client. Gated by [`LiveConsentDecider`]
/// (scope `wildflower/AuthorizationRequest.u`), which also carries the approver's
/// own scopes: an approval delegating a resource scope beyond them is rejected
/// with a `403`. Approving a prompt whose client, redirect, or scopes are
/// outside the current registration without
/// [`acknowledged_registration`](ApproveOAuthConsentBody::acknowledged_registration)
/// is rejected with a `409` and writes nothing. The transaction lives in the
/// consent capability's `approve_oauth`.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_approve_oauth_consent)
}

async fn handle_approve_oauth_consent(
    consents: Scoped<LiveConsentDecider>,
    origin: ServedOrigin,
    Path(id): Path<String>,
    Json(body): Json<ApproveOAuthConsentBody>,
) -> Result<Json<ConsentResult>, GatekeeperError> {
    let outcome = consents.approve_oauth(
        &id,
        ApproveOAuthConsentInput {
            approved_scopes: body.approved_scopes,
            patient: body.patient,
            acknowledged_registration: body.acknowledged_registration,
        },
        generate_authorization_code,
        Utc::now(),
        &origin,
    )?;
    Ok(Json(outcome.into()))
}

//! `POST /authorization/oauth-consents/{id}/approve`: the Owner approves an app's
//! request from its consent card.

use axum::extract::Path;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;
use wildflowerhealthio_scope_capabilities::InsufficientScopeBody;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{ApproveOAuthConsentInput, Scoped};
use crate::http::errors::{
    LaunchPatientMismatchBody, OAuthConsentNotFoundBody, RegistrationNotAcknowledgedBody,
};
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

/// The `409` an approval is refused with, writing nothing: either body, told
/// apart by its `error`. Only the spec reads it; each is rendered from its
/// own [`AuthorizationServerError`] variant.
#[derive(ToSchema)]
#[serde(untagged)]
#[allow(dead_code)]
pub(crate) enum OAuthConsentApprovalConflictBody {
    /// The approval steps outside the app's registration without the
    /// Owner's acknowledgement.
    RegistrationNotAcknowledged(RegistrationNotAcknowledgedBody),
    /// The approval names a patient other than the one the request's SMART
    /// launch binds.
    LaunchPatientMismatch(LaunchPatientMismatchBody),
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
#[utoipa::path(
    post,
    tag = "Owner consent",
    path = "/oauth-consents/{id}/approve",
    params(("id" = String, Path, description = "The authorization request's id")),
    request_body = ApproveOAuthConsentBody,
    responses(
        (status = 200, description = "The request is decided: `approved` with the app's callback carrying the code, or `denied` with the callback carrying `access_denied` when nothing was granted, the requesting browser's session has ended or the app was disabled since", body = ConsentResult),
        (status = 403, description = "The caller's token lacks an approval scope, or a ticked resource scope is beyond the approver's own grant; nothing is written", body = InsufficientScopeBody),
        (status = 404, description = "No pending code-flow request has that id", body = OAuthConsentNotFoundBody),
        (status = 409, description = "The registration change wasn't acknowledged, or the body names a patient other than the one the launch bound; nothing is written", body = OAuthConsentApprovalConflictBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_approve_oauth_consent(
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

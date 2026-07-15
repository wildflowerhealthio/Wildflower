use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::actions::ApproveOAuthConsentInput;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::facades::ConsentDecider;
use crate::http::scoped::Scoped;
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::{ApproveBody, ConsentResult};
use crate::http::CallerSession;

/// `POST /oauth-consents/{id}/approve` — the Owner approves a consent prompt,
/// granting a (narrowed) scope set and minting the authorization code the
/// polling endpoint hands back to the client. Gated by [`ConsentDecider`] (scope
/// `wildflower/AuthorizationRequest.u`); the approver's own scopes
/// ([`CallerSession`]) additionally clamp what may be delegated (a `403` if the
/// approval would exceed them). The transaction lives in
/// [`actions::approve_oauth_consent`](crate::domain::actions::approve_oauth_consent).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_approve_oauth_consent)
}

async fn handle_approve_oauth_consent(
    consents: Scoped<ConsentDecider>,
    caller: CallerSession,
    Path(id): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, GatekeeperError> {
    let outcome = consents.approve_oauth(
        &id,
        ApproveOAuthConsentInput {
            approved_scopes: body.approved_scopes,
            patient: body.patient,
        },
        &caller.granted_scopes(),
        generate_authorization_code,
        Utc::now(),
    )?;
    Ok(Json(outcome.into()))
}

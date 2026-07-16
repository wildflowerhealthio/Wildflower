use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use crate::domain::actions::ApproveDeviceConsentInput;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::facades::ConsentDecider;
use crate::http::scoped::Scoped;
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::{ApproveBody, ConsentResult};
use crate::http::CallerSession;

/// `POST /devices/{userCode}/approve` — the Owner approves a device-code
/// consent prompt, granting the (expanded) scope set and leaving a standing
/// device grant. Gated by [`ConsentDecider`] (scope
/// `wildflower/AuthorizationRequest.u`); the approver's own scopes
/// ([`CallerSession`]) clamp what may be delegated. The transaction lives in
/// [`actions::approve_device_consent`](crate::domain::actions::approve_device_consent).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_approve_device_consent)
}

async fn handle_approve_device_consent(
    consents: Scoped<ConsentDecider>,
    approver: CallerSession,
    Path(user_code): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, GatekeeperError> {
    let outcome = consents.approve_device(
        &user_code,
        ApproveDeviceConsentInput {
            approved_scopes: body.approved_scopes,
            patient: body.patient,
            device_name: body.device_name,
        },
        &approver.granted_scopes(),
        Utc::now(),
    )?;
    Ok(Json(outcome.into()))
}

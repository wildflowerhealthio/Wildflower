use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use crate::domain::actions::ApproveDeviceConsentInput;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::capabilities::{ConsentDecider, Scoped};
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::{ApproveBody, ConsentResult};

/// `POST /devices/{userCode}/approve` — the Owner approves a device-code
/// consent prompt, granting the (expanded) scope set and leaving a standing
/// device grant. Gated by [`ConsentDecider`] (scope
/// `wildflower/AuthorizationRequest.u`), which also carries the approver's own
/// scopes: an approval delegating a resource scope beyond them is rejected with
/// a `403`. The transaction lives in
/// [`actions::approve_device_consent`](crate::domain::actions::approve_device_consent).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_approve_device_consent)
}

async fn handle_approve_device_consent(
    consents: Scoped<ConsentDecider>,
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
        Utc::now(),
    )?;
    Ok(Json(outcome.into()))
}

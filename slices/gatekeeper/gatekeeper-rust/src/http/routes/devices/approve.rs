use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use crate::domain::actions;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;
use crate::http::wire_representations::{ApproveBody, ConsentResult};

/// `POST /devices/{userCode}/approve` — the Owner approves a device-code
/// consent prompt, granting the (expanded) scope set and leaving a standing
/// device grant. All of that lives in [`actions::approve_device_consent`]; the
/// handler just adapts HTTP ⇄ domain.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_approve_device_consent)
}

async fn handle_approve_device_consent(
    State(state): State<AppState>,
    Path(user_code): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let outcome = actions::approve_device_consent(
        &state.store,
        &state,
        &user_code,
        actions::ApproveDeviceConsentInput {
            approved_scopes: body.approved_scopes,
            patient: body.patient,
            device_name: body.device_name,
        },
        Utc::now(),
    )?;
    Ok(Json(outcome.into()))
}

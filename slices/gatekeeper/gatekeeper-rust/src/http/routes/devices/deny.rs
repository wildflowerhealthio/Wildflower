use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::capabilities::{ConsentDecider, Scoped};
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::ConsentResult;

/// `POST /devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt (scope `wildflower/AuthorizationRequest.u`).
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    post(handle_deny_device_consent)
}

async fn handle_deny_device_consent(
    consents: Scoped<ConsentDecider>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, GatekeeperError> {
    consents.deny_device(&user_code)?;
    Ok(Json(ConsentResult::Denied))
}

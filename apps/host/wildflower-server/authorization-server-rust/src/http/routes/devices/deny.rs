//! `POST /authorization/devices/{userCode}/deny`: the Owner declines a device or
//! a browser pairing at the device page.

use chrono::Utc;
use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::ConsentResult;
use crate::live_bindings::LiveConsentDecider;

/// The `POST` method on `/devices/{userCode}/deny`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_deny_device_consent)
}

/// `POST /authorization/devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt (scope `wildflower/AuthorizationRequest.u`).
async fn handle_deny_device_consent(
    consents: Scoped<LiveConsentDecider>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    consents.deny_device_consent(&user_code, Utc::now())?;
    Ok(Json(ConsentResult::Denied { redirect: None }))
}

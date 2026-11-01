//! `POST /authorization/devices/{userCode}/deny`: the Owner declines a device or
//! a browser pairing at the device page.

use chrono::Utc;

use axum::extract::Path;
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::errors::DeviceConsentNotFoundBody;
use crate::http::wire_representations::{ConsentResult, PolledConsentResult};
use crate::live_bindings::LiveConsentDecider;

/// `POST /authorization/devices/{userCode}/deny` — the Owner declines a device-code consent
/// prompt (scope `wildflower/AuthorizationRequest.u`).
#[utoipa::path(
    post,
    tag = "Owner consent",
    path = "/devices/{userCode}/deny",
    params(("userCode" = String, Path, description = "The code the device page shows")),
    responses(
        (status = 200, description = "The request is declined: always `denied`", body = PolledConsentResult),
        (status = 404, description = "No pending device or pairing request has that user code", body = DeviceConsentNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_deny_device_consent(
    consents: Scoped<LiveConsentDecider>,
    Path(user_code): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    consents.deny_device_consent(&user_code, Utc::now())?;
    Ok(Json(ConsentResult::Denied { redirect: None }))
}

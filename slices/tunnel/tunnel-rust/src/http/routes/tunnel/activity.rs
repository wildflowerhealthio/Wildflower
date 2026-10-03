//! `GET /tunnel/activity` — the request log grouped by (caller, client address).

use axum::Json;

use scope_capabilities_rust::InsufficientScopeBody;

use super::wire_representations::RequestActivityBody;
use crate::domain::capabilities::Scoped;
use crate::domain::TunnelError;
use crate::live_bindings::LiveRequestLogReader;

/// `GET /tunnel/activity` — who reached the server through the tunnel: one row
/// per (caller, client address), the group with the newest request first.
/// Gated by [`Scoped<LiveRequestLogReader>`] (`wildflower/TunnelSettings.r`).
#[utoipa::path(
    get,
    tag = "Request log",
    path = "/tunnel/activity",
    responses(
        (status = 200, description = "The request log grouped by caller and client address, newest first", body = [RequestActivityBody]),
        (status = 403, description = "The caller's token doesn't cover `wildflower/TunnelSettings.r`", body = InsufficientScopeBody)
    )
)]
pub(super) async fn handle_get_activity(
    request_log: Scoped<LiveRequestLogReader>,
) -> Result<Json<Vec<RequestActivityBody>>, TunnelError> {
    Ok(Json(
        request_log
            .activity()?
            .into_iter()
            .map(RequestActivityBody::from)
            .collect(),
    ))
}

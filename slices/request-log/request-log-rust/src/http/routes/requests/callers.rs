//! `GET /requests/callers` — the request log grouped by (caller, client address).

use axum::Json;

use scope_capabilities_rust::InsufficientScopeBody;

use super::wire_representations::CallerSummaryBody;
use crate::domain::capabilities::Scoped;
use crate::domain::RequestLogError;
use crate::live_bindings::LiveRequestLogReader;

/// `GET /requests/callers` — who reached the server: one row per (caller, client
/// address), the group with the newest request first. Gated by [`Scoped<LiveRequestLogReader>`] (`wildflower/RequestLog.r`).
#[utoipa::path(
    get,
    tag = "Request log",
    path = "/requests/callers",
    responses(
        (status = 200, description = "The request log grouped by caller and client address, newest first", body = [CallerSummaryBody]),
        (status = 403, description = "The caller's token doesn't cover `wildflower/RequestLog.r`", body = InsufficientScopeBody)
    )
)]
pub(crate) async fn handle_list_callers(
    request_log: Scoped<LiveRequestLogReader>,
) -> Result<Json<Vec<CallerSummaryBody>>, RequestLogError> {
    Ok(Json(
        request_log
            .caller_summaries()?
            .into_iter()
            .map(CallerSummaryBody::from)
            .collect(),
    ))
}

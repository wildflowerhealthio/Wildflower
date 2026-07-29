//! `POST /sniffer/cancellations` — ask the sniffed page's shims to abort an
//! in-flight request by its correlation id. Replaces the bridge's
//! `CancelSnifferRequest` tag.

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::capabilities::SnifferDriver;
use crate::domain::SnifferError;

/// POST body — the sniffer's per-request correlation id.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CancelRequestBody {
    id: String,
}

/// `POST /sniffer/cancellations` — cancel an in-flight sniffed request.
/// Speculative by design (the collector cancels during teardown), so a missing
/// webview is still a 204. Gated by `Scoped<SnifferDriver>`
/// (`wildflower/Sniffer.c`).
#[utoipa::path(
    post,
    tag = "Sniffer",
    path = "/sniffer/cancellations",
    request_body = CancelRequestBody,
    responses(
        (status = 204, description = "The cancellation was forwarded (or no webview was up)"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Sniffer.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_cancel_request(
    sniffer: Scoped<SnifferDriver>,
    Json(body): Json<CancelRequestBody>,
) -> Result<StatusCode, SnifferError> {
    sniffer.cancel_request(&body.id)?;
    Ok(StatusCode::NO_CONTENT)
}

//! `POST /sniffer/webview` — open the sniffer webview on a source (or navigate
//! the live one). Replaces the bridge's `RequestSniffableWebView` and `Open`
//! tags, whose host effect was identical (both resolved the source and
//! open-or-navigated); one endpoint covers both.

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::capabilities::SnifferDriver;
use crate::domain::{SnifferError, WebViewSourcePayload};
use crate::http::errors::InvalidSourceBody;

/// POST body. `linkedSpan` is the caller's trace linkage — accepted (the TS
/// runner sends it on the run-opening message) but unused by this host today,
/// exactly as the retired bridge decoder decoded-and-dropped it.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenWebviewBody {
    source: WebViewSourcePayload,
    #[expect(
        dead_code,
        reason = "decoded-and-dropped: kept on the wire so a tracing host can adopt it \
                  without a client change"
    )]
    #[schema(value_type = Option<Value>)]
    linked_span: Option<serde_json::Value>,
}

/// `POST /sniffer/webview` — validate the source and open/navigate the sniffer
/// webview to it. Gated by `Scoped<SnifferDriver>` (`wildflower/Sniffer.c`).
#[utoipa::path(
    post,
    tag = "Sniffer",
    path = "/sniffer/webview",
    request_body = OpenWebviewBody,
    responses(
        (status = 204, description = "The sniffer webview is opening (or navigating) to the source"),
        (status = 400, description = "The source was rejected (non-http(s) URI, or the unsupported Html variant)", body = InvalidSourceBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Sniffer.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_open_webview(
    sniffer: Scoped<SnifferDriver>,
    Json(body): Json<OpenWebviewBody>,
) -> Result<StatusCode, SnifferError> {
    sniffer.open(body.source)?;
    Ok(StatusCode::NO_CONTENT)
}

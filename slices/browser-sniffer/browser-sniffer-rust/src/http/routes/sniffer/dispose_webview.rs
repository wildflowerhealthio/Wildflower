//! `DELETE /sniffer/webview` — tear the sniffer webview down. Replaces the
//! bridge's terminal `SniffingComplete` tag; the host reports the teardown
//! back on the event stream as a `SnifferDisposed` lifecycle event.

use axum::http::StatusCode;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::capabilities::SnifferDriver;
use crate::domain::SnifferError;

/// `DELETE /sniffer/webview` — dispose the sniffer webview and free its
/// resources. Idempotent: disposing when none is up is a success. Gated by
/// `Scoped<SnifferDriver>` (`wildflower/Sniffer.c`).
#[utoipa::path(
    delete,
    tag = "Sniffer",
    path = "/sniffer/webview",
    responses(
        (status = 204, description = "The sniffer webview is disposed (or none was up)"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Sniffer.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_dispose_webview(
    sniffer: Scoped<SnifferDriver>,
) -> Result<StatusCode, SnifferError> {
    sniffer.dispose()?;
    Ok(StatusCode::NO_CONTENT)
}

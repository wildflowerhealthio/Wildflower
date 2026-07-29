//! `POST /sniffer/visibility` — (re-)present a hidden-but-alive sniffer
//! webview without navigating. Replaces the bridge's `EnsureSnifferVisible`
//! tag (the collector's fire-and-advance `EnsureWindowVisible` step).

use axum::http::StatusCode;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::capabilities::SnifferDriver;
use crate::domain::SnifferError;

/// `POST /sniffer/visibility` — show the sniffer webview. Idempotent, and a
/// no-op when none exists (the plugin's `show` can't tell "absent" from
/// "already visible", so — like the bridge message — nothing distinguishes the
/// two; a 204 means the request was honored, not that a window appeared).
/// Gated by `Scoped<SnifferDriver>` (`wildflower/Sniffer.c`).
#[utoipa::path(
    post,
    tag = "Sniffer",
    path = "/sniffer/visibility",
    responses(
        (status = 204, description = "The show request was dispatched (best-effort)"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Sniffer.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_show_webview(
    sniffer: Scoped<SnifferDriver>,
) -> Result<StatusCode, SnifferError> {
    sniffer.show()?;
    Ok(StatusCode::NO_CONTENT)
}

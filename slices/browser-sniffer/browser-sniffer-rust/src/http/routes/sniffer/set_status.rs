//! `PUT /sniffer/status` — write the per-step status label to the sniffer
//! chrome's subtitle. Replaces the bridge's `SetSnifferStatus` tag.

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::capabilities::SnifferDriver;
use crate::domain::SnifferError;

/// PUT body — the step's display name (e.g. "Entering email").
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SetStatusBody {
    name: String,
}

/// `PUT /sniffer/status` — set the sniffer chrome's subtitle. A no-op when no
/// webview is up (the chrome patch reports `set: false`, never an error).
/// Gated by `Scoped<SnifferDriver>` (`wildflower/Sniffer.c`).
#[utoipa::path(
    put,
    tag = "Sniffer",
    path = "/sniffer/status",
    request_body = SetStatusBody,
    responses(
        (status = 204, description = "The status subtitle is set (or no webview was up)"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Sniffer.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_set_status(
    sniffer: Scoped<SnifferDriver>,
    Json(body): Json<SetStatusBody>,
) -> Result<StatusCode, SnifferError> {
    sniffer.set_status(&body.name)?;
    Ok(StatusCode::NO_CONTENT)
}

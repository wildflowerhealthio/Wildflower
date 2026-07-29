//! `POST /sniffer/page-actions` — forward a scripted interaction (`Click` /
//! `Fill`) into the sniffed page. Replaces the bridge's `PageAction` tag; on
//! every platform the forward now rides the host's `evaluate_js` path (the
//! desktop content webview's direct bus listen is retired with the bridge).

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::capabilities::SnifferDriver;
use crate::domain::{PageActionPayload, SnifferError};

/// POST body — the action union the injected sniffer bootstrap demuxes by
/// `kind`.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct PageActionBody {
    action: PageActionPayload,
}

/// `POST /sniffer/page-actions` — script an interaction inside the sniffed
/// page. Gated by `Scoped<SnifferDriver>` (`wildflower/Sniffer.c`).
#[utoipa::path(
    post,
    tag = "Sniffer",
    path = "/sniffer/page-actions",
    request_body = PageActionBody,
    responses(
        (status = 204, description = "The action was forwarded into the page"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Sniffer.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_page_action(
    sniffer: Scoped<SnifferDriver>,
    Json(body): Json<PageActionBody>,
) -> Result<StatusCode, SnifferError> {
    sniffer.page_action(&body.action)?;
    Ok(StatusCode::NO_CONTENT)
}

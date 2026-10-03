//! `GET /tunnel/requests` — the raw request log, keyset-paged on id.

use axum::extract::Query;
use axum::Json;
use serde::Deserialize;
use utoipa::IntoParams;

use scope_capabilities_rust::InsufficientScopeBody;

use super::wire_representations::RequestLogPageBody;
use crate::domain::capabilities::Scoped;
use crate::domain::request_log::RequestLogFilter;
use crate::domain::TunnelError;
use crate::live_bindings::LiveRequestLogReader;

/// The query `GET /tunnel/requests` accepts. Every parameter is optional, and
/// every one given must match.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(super) struct ListRequestsParams {
    /// The previous page's `nextCursor`: only requests older than it.
    cursor: Option<i64>,
    /// Only requests whose verified caller is this OAuth client.
    client: Option<String>,
    /// Only requests from this client address.
    address: Option<String>,
    /// `true` for only refused requests (a bearer gate's `401` or a scope
    /// `403`), `false` for only the rest.
    refused: Option<bool>,
}

impl From<ListRequestsParams> for RequestLogFilter {
    fn from(params: ListRequestsParams) -> Self {
        RequestLogFilter {
            before_id: params.cursor,
            client_id: params.client,
            client_address: params.address,
            refused: params.refused,
        }
    }
}

/// `GET /tunnel/requests` — one page of the request log, newest first, with the
/// cursor for the next. Gated by [`Scoped<LiveRequestLogReader>`]
/// (`wildflower/TunnelSettings.r`).
#[utoipa::path(
    get,
    tag = "Request log",
    path = "/tunnel/requests",
    params(ListRequestsParams),
    responses(
        (status = 200, description = "One page of the request log, newest first", body = RequestLogPageBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/TunnelSettings.r`", body = InsufficientScopeBody)
    )
)]
pub(super) async fn handle_list_requests(
    request_log: Scoped<LiveRequestLogReader>,
    Query(params): Query<ListRequestsParams>,
) -> Result<Json<RequestLogPageBody>, TunnelError> {
    Ok(Json(
        request_log
            .requests_page(&RequestLogFilter::from(params))?
            .into(),
    ))
}

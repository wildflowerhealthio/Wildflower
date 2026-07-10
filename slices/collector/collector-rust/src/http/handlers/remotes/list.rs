//! `GET /collector/remotes` — the full remotes catalogue, oldest first.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::Remote;
use crate::http::response_templates::HandlerError;
use crate::http::state::CollectorState;

/// `GET /collector/remotes` — list every remote. Owner-gated by the host.
#[utoipa::path(
    get,
    path = "/collector/remotes",
    responses(
        (status = 200, description = "Every stored remote, oldest first", body = [Remote]),
    ),
)]
pub(crate) async fn handle_list_remotes(
    State(state): State<Arc<CollectorState>>,
) -> Result<Json<Vec<Remote>>, HandlerError> {
    let remotes = state
        .store
        .list_remotes()
        .map_err(|e| HandlerError::internal("list_remotes failed", e))?;
    Ok(Json(remotes))
}

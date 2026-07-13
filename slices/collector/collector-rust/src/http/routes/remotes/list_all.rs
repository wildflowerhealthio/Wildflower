//! `GET /collector/remotes` — the full remotes catalogue, oldest first.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::{actions, Remote, RemoteError};
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
) -> Result<Json<Vec<Remote>>, RemoteError> {
    let remotes = actions::list_remotes(&state.store)?;
    Ok(Json(remotes))
}

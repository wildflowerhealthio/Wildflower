//! `GET /collector/remotes/{id}` — a single remote, or the structured 404.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;

use crate::domain::{Remote, RemoteError};
use crate::http::errors::RemoteNotFoundBody;
use crate::http::state::CollectorState;

/// `GET /collector/remotes/{id}` — fetch one remote. Owner-gated by the host.
#[utoipa::path(
    get,
    path = "/collector/remotes/{id}",
    params(("id" = String, Path, description = "Remote id")),
    responses(
        (status = 200, description = "The remote", body = Remote),
        (status = 404, description = "No remote has this id", body = RemoteNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_remote(
    State(state): State<Arc<CollectorState>>,
    Path(id): Path<String>,
) -> Result<Json<Remote>, RemoteError> {
    let remote = state
        .store
        .find_remote(&id)?
        .ok_or(RemoteError::NotFound { id })?;
    Ok(Json(remote))
}

//! `DELETE /collector/remotes/{id}` — remove a remote. Unknown ids return the
//! structured 404.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::{actions, RemoteError};
use crate::http::errors::RemoteNotFoundBody;
use crate::http::state::CollectorState;

/// Wire shape for the delete acknowledgement — matches the TS success schema
/// (`Schema.Struct({ deleted: Schema.Boolean })`).
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /collector/remotes/{id}` — remove a remote. Owner-gated by the host.
#[utoipa::path(
    delete,
    path = "/collector/remotes/{id}",
    params(("id" = String, Path, description = "Remote id")),
    responses(
        (status = 200, description = "The row was removed", body = DeletedBody),
        (status = 404, description = "No remote has this id", body = RemoteNotFoundBody),
    ),
)]
pub(crate) async fn handle_delete_remote(
    State(state): State<Arc<CollectorState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, RemoteError> {
    actions::delete_remote(&state.store, &id)?;
    Ok(Json(DeletedBody { deleted: true }))
}

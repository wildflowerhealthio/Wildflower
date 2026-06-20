//! `DELETE /databases/{id}` — delete a database file on disk.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::files::delete_database_files;
use crate::http::response_templates::HandlerError;
use crate::http::state::DatabasesState;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /databases/{id}` — remove the database file (and its journal
/// sidecars) from disk. Unknown ids and already-absent databases are
/// `404 DatabaseNotFound`.
///
/// This deletes the file out from under the slice that owns the live
/// connection. On Unix the open inode survives until that connection closes, so
/// the running server keeps working against the now-unlinked file; the deletion
/// takes full effect on the next restart, when a fresh empty database is
/// created. (The Owner who triggers this is asking to erase the database — see
/// the settings screen's confirmation.)
#[utoipa::path(
    delete,
    path = "/databases/{id}",
    params(
        ("id" = String, Path, description = "Database resource id (filename)"),
    ),
    responses(
        (status = 200, description = "The database file was deleted", body = DeletedBody),
        (status = 404, description = "No database has this id, or it doesn't exist", body = crate::http::response_templates::DatabaseNotFoundBody),
    ),
)]
pub(crate) async fn handle_delete_database(
    State(state): State<Arc<DatabasesState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, HandlerError> {
    let descriptor = state
        .descriptor(&id)
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;
    let path = state.path_for(descriptor);
    if !path.exists() {
        return Err(HandlerError::NotFound { id });
    }

    delete_database_files(&path)
        .map_err(|error| HandlerError::internal("delete_database_files failed", error))?;
    Ok(Json(DeletedBody { deleted: true }))
}

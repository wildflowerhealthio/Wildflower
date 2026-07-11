//! `DELETE /databases/{id}` — schedule a database for deletion at next startup.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::files::schedule_deletion;
use crate::http::errors::HandlerError;
use crate::http::state::DatabasesState;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /databases/{id}` — schedule the database for deletion. Unknown ids
/// and already-absent databases are `404 DatabaseNotFound`.
///
/// The owning slice holds the database open for the whole app lifetime, so it
/// can't be removed reliably at runtime (a Windows sharing violation, or a live
/// inode on Unix). Instead this drops a pending-deletion marker; the host
/// removes the file at the next startup, before any connection opens (see
/// `files::purge_pending_deletions`). The database therefore still exists — and
/// stays served — until the app is restarted, which the settings UI tells the
/// Owner to do. `deleted: true` means "the request was accepted/scheduled".
#[utoipa::path(
    delete,
    tag = "Management",
    path = "/databases/{id}",
    params(
        ("id" = String, Path, description = "Database resource id (filename)"),
    ),
    responses(
        (status = 200, description = "Deletion was scheduled (takes effect on restart)", body = DeletedBody),
        (status = 404, description = "No database has this id, or it doesn't exist", body = crate::http::errors::DatabaseNotFoundBody),
    ),
)]
pub(crate) async fn handle_delete_database(
    State(state): State<Arc<DatabasesState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, HandlerError> {
    let Some((_descriptor, path)) = state.existing(&id) else {
        return Err(HandlerError::NotFound { id });
    };
    schedule_deletion(&path)
        .map_err(|error| HandlerError::internal("schedule_deletion failed", error))?;
    Ok(Json(DeletedBody { deleted: true }))
}

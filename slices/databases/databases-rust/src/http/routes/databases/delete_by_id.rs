//! `DELETE /databases/{id}` — schedule a database for deletion at next startup.

use axum::extract::Path;
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::DatabaseError;
use crate::http::errors::DatabaseNotFoundBody;
use crate::http::scoped::{DatabasesDeleter, Scoped};

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
        (status = 404, description = "No database has this id, or it doesn't exist", body = DatabaseNotFoundBody),
    ),
)]
pub(crate) async fn handle_delete_database(
    deleter: Scoped<DatabasesDeleter>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, DatabaseError> {
    // The `delete_scope` check and the blocking marker write live in the facade
    // (a `403` on an under-scoped token, a `404` on unknown/absent).
    deleter.delete(&id).await?;
    Ok(Json(DeletedBody { deleted: true }))
}

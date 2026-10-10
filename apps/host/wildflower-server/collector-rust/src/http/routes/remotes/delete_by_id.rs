//! `DELETE /collector/remotes/{id}` — remove a remote. Unknown ids return the
//! structured 404.

use axum::extract::Path;
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::RemoteError;
use crate::http::errors::RemoteNotFoundBody;
use crate::live_bindings::LiveRemotesDeleter;

/// Wire shape for the delete acknowledgement — matches the TS success schema
/// (`Schema.Struct({ deleted: Schema.Boolean })`).
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /collector/remotes/{id}` — remove a remote. Gated by
/// [`Scoped<LiveRemotesDeleter>`] (`wildflower/Accounts.d`); the capability is the
/// only door to the store, so this handler never sees the state.
#[utoipa::path(
    delete,
    tag = "Remotes",
    path = "/collector/remotes/{id}",
    params(("id" = String, Path, description = "Remote id")),
    responses(
        (status = 200, description = "The row was removed", body = DeletedBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Accounts.d`", body = InsufficientScopeBody),
        (status = 404, description = "No remote has this id", body = RemoteNotFoundBody),
    ),
)]
pub(crate) async fn handle_delete_remote(
    remotes: Scoped<LiveRemotesDeleter>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, RemoteError> {
    remotes.delete(&id)?;
    Ok(Json(DeletedBody { deleted: true }))
}

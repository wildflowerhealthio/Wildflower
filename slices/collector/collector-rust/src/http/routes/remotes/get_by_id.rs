//! `GET /collector/remotes/{id}` — a single remote, or the structured 404.

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::{Remote, RemoteError};
use crate::http::errors::RemoteNotFoundBody;
use crate::state::RemotesReaderCap;

/// `GET /collector/remotes/{id}` — fetch one remote. Gated by
/// [`Scoped<RemotesReaderCap>`] (`wildflower/Accounts.r`); the scope check runs
/// during extraction, before this body, so an under-scoped caller gets a `403`
/// whether or not the id exists.
#[utoipa::path(
    get,
    tag = "Remotes",
    path = "/collector/remotes/{id}",
    params(("id" = String, Path, description = "Remote id")),
    responses(
        (status = 200, description = "The remote", body = Remote),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Accounts.r`", body = InsufficientScopeBody),
        (status = 404, description = "No remote has this id", body = RemoteNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_remote(
    remotes: Scoped<RemotesReaderCap>,
    Path(id): Path<String>,
) -> Result<Json<Remote>, RemoteError> {
    Ok(Json(remotes.get(&id)?))
}

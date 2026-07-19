//! `GET /collector/remotes` — the full remotes catalogue, oldest first.

use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::{Remote, RemoteError};
use crate::live_bindings::LiveRemotesReader;

/// `GET /collector/remotes` — list every remote. Gated by
/// [`Scoped<LiveRemotesReader>`] (`wildflower/Accounts.r`): a remote's `config`
/// can carry origin credentials, so even the listing requires the read scope. The
/// capability is the only door to the store — this handler never sees the state.
#[utoipa::path(
    get,
    tag = "Remotes",
    path = "/collector/remotes",
    responses(
        (status = 200, description = "Every stored remote, oldest first", body = [Remote]),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Accounts.r`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_list_remotes(
    remotes: Scoped<LiveRemotesReader>,
) -> Result<Json<Vec<Remote>>, RemoteError> {
    Ok(Json(remotes.list()?))
}

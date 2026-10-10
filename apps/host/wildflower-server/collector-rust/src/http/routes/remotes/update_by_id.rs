//! `PUT /collector/remotes/{id}` — full replace of a remote's `name` +
//! `config` (`tag` is re-denormalized from the new `config._tag`; `id` and
//! `addedAt` are immutable). Unknown ids return the structured 404.

use axum::extract::Path;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::{Remote, RemoteError};
use crate::http::errors::{InvalidConfigBody, RemoteNotFoundBody};
use crate::live_bindings::LiveRemotesEditor;

/// PUT body — matches the TS `UpdateRemotePayloadSchema`. Both fields are
/// required (a full replace, not a patch); `config` stays opaque to Rust.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRemoteBody {
    name: String,
    #[schema(value_type = Value)]
    config: serde_json::Value,
}

/// `PUT /collector/remotes/{id}` — replace a remote's name + config. Gated by
/// [`Scoped<LiveRemotesEditor>`] (`wildflower/Accounts.u`); the capability is the
/// only door to the store, so this handler never sees the state.
#[utoipa::path(
    put,
    tag = "Remotes",
    path = "/collector/remotes/{id}",
    params(("id" = String, Path, description = "Remote id")),
    request_body = UpdateRemoteBody,
    responses(
        (status = 200, description = "The updated remote", body = Remote),
        (status = 400, description = "The config carries no string `_tag`", body = InvalidConfigBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Accounts.u`", body = InsufficientScopeBody),
        (status = 404, description = "No remote has this id", body = RemoteNotFoundBody),
    ),
)]
pub(crate) async fn handle_update_remote(
    remotes: Scoped<LiveRemotesEditor>,
    Path(id): Path<String>,
    Json(body): Json<UpdateRemoteBody>,
) -> Result<Json<Remote>, RemoteError> {
    let updated = remotes.update(&id, &body.name, &body.config)?;
    Ok(Json(updated))
}

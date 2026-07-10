//! `PUT /collector/remotes/{id}` — full replace of a remote's `name` +
//! `config` (`tag` is re-denormalized from the new `config._tag`; `id` and
//! `addedAt` are immutable). Unknown ids return the structured 404.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::Remote;
use crate::http::handlers::remotes::create::required_config_tag;
use crate::http::response_templates::{HandlerError, RemoteNotFoundBody};
use crate::http::state::CollectorState;

/// PUT body — matches the TS `UpdateRemotePayloadSchema`. Both fields are
/// required (a full replace, not a patch); `config` stays opaque to Rust.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRemoteBody {
    name: String,
    #[schema(value_type = Value)]
    config: serde_json::Value,
}

/// `PUT /collector/remotes/{id}` — replace a remote's name + config.
/// Owner-gated by the host.
#[utoipa::path(
    put,
    path = "/collector/remotes/{id}",
    params(("id" = String, Path, description = "Remote id")),
    request_body = UpdateRemoteBody,
    responses(
        (status = 200, description = "The updated remote", body = Remote),
        (status = 404, description = "No remote has this id", body = RemoteNotFoundBody),
    ),
)]
pub(crate) async fn handle_update_remote(
    State(state): State<Arc<CollectorState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateRemoteBody>,
) -> Result<Json<Remote>, HandlerError> {
    let tag = required_config_tag(&body.config)?;
    let updated = state
        .store
        .update_remote(&id, &body.name, &tag, &body.config)
        .map_err(|e| HandlerError::internal("update_remote failed", e))?
        .ok_or(HandlerError::NotFound { id })?;
    Ok(Json(updated))
}

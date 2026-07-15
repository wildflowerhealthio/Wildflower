//! `POST /collector/remotes` — store a new remote. The id is client-minted
//! (matching the TS `CreateRemotePayloadSchema`); `tag` is denormalized from
//! `config._tag` and `added_at` is stamped server-side at insert time.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{actions, Remote, RemoteError};
use crate::http::errors::{InvalidConfigBody, RemoteAlreadyExistsBody};
use crate::http::state::CollectorState;

/// POST body — matches the TS `CreateRemotePayloadSchema`. `config` is the
/// tagged `CollectorConfig` JSON, opaque to Rust (see [`Remote::config`]) —
/// `value_type = Value` keeps its OpenAPI schema an unconstrained wildcard.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateRemoteBody {
    id: String,
    name: String,
    #[schema(value_type = Value)]
    config: serde_json::Value,
}

/// `POST /collector/remotes` — create a remote. Owner-gated by the host.
#[utoipa::path(
    post,
    tag = "Remotes",
    path = "/collector/remotes",
    request_body = CreateRemoteBody,
    responses(
        (status = 200, description = "The created remote", body = Remote),
        (status = 400, description = "The config carries no string `_tag`", body = InvalidConfigBody),
        (status = 409, description = "A remote with this id already exists", body = RemoteAlreadyExistsBody),
    ),
)]
pub(crate) async fn handle_create_remote(
    State(state): State<Arc<CollectorState>>,
    Json(body): Json<CreateRemoteBody>,
) -> Result<Json<Remote>, RemoteError> {
    let remote = actions::create_remote(&state.store, body.id, body.name, body.config)?;
    Ok(Json(remote))
}

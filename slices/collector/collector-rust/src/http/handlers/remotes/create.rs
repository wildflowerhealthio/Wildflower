//! `POST /collector/remotes` — store a new remote. The id is client-minted
//! (matching the TS `CreateRemotePayloadSchema`); `tag` is denormalized from
//! `config._tag` and `added_at` is stamped server-side at insert time.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use chrono::{SecondsFormat, Utc};
use persistence_rust::JsonColumn;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{config_tag, Remote};
use crate::http::response_templates::HandlerError;
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
    path = "/collector/remotes",
    request_body = CreateRemoteBody,
    responses(
        (status = 200, description = "The created remote", body = Remote),
    ),
)]
pub(crate) async fn handle_create_remote(
    State(state): State<Arc<CollectorState>>,
    Json(body): Json<CreateRemoteBody>,
) -> Result<Json<Remote>, HandlerError> {
    let tag = required_config_tag(&body.config)?;
    let remote = Remote {
        id: body.id,
        name: body.name,
        tag,
        config: JsonColumn(body.config),
        added_at: now_added_at(),
    };
    let inserted = state
        .store
        .insert_remote(&remote)
        .map_err(|e| HandlerError::internal("insert_remote failed", e))?;
    if !inserted {
        return Err(HandlerError::AlreadyExists { id: remote.id });
    }
    Ok(Json(remote))
}

/// The `config._tag` discriminant, or the 400 the write surface answers when
/// it's absent — without it neither the `tag` column nor the wire `tag` field
/// can be produced. Unreachable through the typed TS client (which validates
/// the config union before sending); shared with the update handler.
pub(super) fn required_config_tag(config: &serde_json::Value) -> Result<String, HandlerError> {
    config_tag(config)
        .map(str::to_owned)
        .ok_or_else(|| HandlerError::InvalidConfig {
            message: "config._tag must be a string".to_owned(),
        })
}

/// Now, as ISO-8601 UTC with milliseconds (e.g. `2026-06-17T14:29:22.363Z`) —
/// the encoding the TS `Schema.DateTimeUtc` round-trips and the seed migration
/// pins.
fn now_added_at() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

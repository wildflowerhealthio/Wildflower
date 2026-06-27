//! `POST /apps` — register a new **cloud** app. Mints a fresh random id, parses
//! the URL through the write-side filter (so an open-redirect never lands in the
//! row), appends it at the next display position, and returns the resulting
//! [`AppEntry`]. Cloud is the only user-creatable kind.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{AppEntry, AppUrl};
use crate::http::response_templates::{HandlerError, InvalidFieldBody};
use crate::http::state::AppsState;
use crate::id::mint_app_id;

/// POST body — matches the TS `CreateAppBodySchema`. `requiresTunnel`
/// uses the wire-camelCase the existing client speaks. `url` is read as a raw
/// string so a bad value yields the structured `400 InvalidUrl` rather than a
/// generic deserialize error.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateAppBody {
    name: String,
    url: String,
    requires_tunnel: bool,
    #[serde(default)]
    subtitle: Option<String>,
}

/// `POST /apps` — create a cloud app. Owner-gated by the host.
#[utoipa::path(
    post,
    path = "/apps",
    request_body = CreateAppBody,
    responses(
        (status = 200, description = "The created cloud app", body = AppEntry),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
    ),
)]
pub(crate) async fn handle_create_app(
    State(state): State<Arc<AppsState>>,
    Json(body): Json<CreateAppBody>,
) -> Result<Json<AppEntry>, HandlerError> {
    if body.name.is_empty() {
        return Err(HandlerError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = body
        .url
        .parse::<AppUrl>()
        .map_err(|e| HandlerError::InvalidUrl {
            message: e.to_string(),
        })?;
    let entry = AppEntry {
        id: mint_app_id(),
        enabled: true,
        name: body.name,
        // Empty subtitle → cleared: a stored `""` would break the catalogue
        // decode (read schemas require a non-empty string). See `SubtitlePatch`.
        subtitle: body.subtitle.filter(|s| !s.is_empty()),
        url,
        requires_tunnel: body.requires_tunnel,
    };
    let position = state
        .store
        .next_position()
        .map_err(|e| HandlerError::internal("next_position failed", e))?;
    let inserted = state
        .store
        .insert_cloud_app(&entry, position)
        .map_err(|e| HandlerError::internal("insert_cloud_app failed", e))?;
    if !inserted {
        // 21-char random id collided — vanishingly unlikely, but surface it
        // as a logged 500 rather than silently returning the existing row.
        tracing::error!("app id collision on {}", entry.id);
        return Err(HandlerError::internal(
            "insert_cloud_app id collision",
            "id already exists",
        ));
    }
    Ok(Json(entry))
}

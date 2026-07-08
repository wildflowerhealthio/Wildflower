//! `POST /apps` — register a new **cloud** app. Mints a fresh random id, parses
//! the URL through the write-side filter (so an open-redirect never lands in the
//! row), appends it at the next display position, and returns the resulting
//! catalogue [`AppListEntry`] (the cloud variant). Cloud is the only
//! user-creatable kind.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{AppListEntry, AppUrl, CloudAppRow};
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
        (status = 200, description = "The created cloud app", body = AppListEntry),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
    ),
)]
pub(crate) async fn handle_create_app(
    State(state): State<Arc<AppsState>>,
    Json(body): Json<CreateAppBody>,
) -> Result<Json<AppListEntry>, HandlerError> {
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
    let app = CloudAppRow {
        id: mint_app_id(),
        enabled: true,
        name: body.name,
        // Empty `""` clears the subtitle.
        subtitle: body.subtitle.filter(|s| !s.is_empty()),
        url,
        requires_tunnel: body.requires_tunnel,
    };
    let inserted = state
        .store
        .insert_cloud_app(&app)
        .map_err(|e| HandlerError::internal("insert_cloud_app failed", e))?;
    if !inserted {
        // 21-char random id collided — vanishingly unlikely, but surface it
        // as a logged 500 rather than silently returning the existing row.
        tracing::error!("app id collision on {}", app.id);
        return Err(HandlerError::internal(
            "insert_cloud_app id collision",
            "id already exists",
        ));
    }
    // Read back the exact `GET /apps` projection so the response can't drift from
    // the catalogue shape (correct computed `smart` / `removable`).
    let entry = state
        .store
        .find_app_entry(&app.id)
        .map_err(|e| HandlerError::internal("find_app_entry after create failed", e))?
        .ok_or_else(|| {
            HandlerError::internal(
                "created cloud app vanished before read-back",
                app.id.clone(),
            )
        })?;
    Ok(Json(entry))
}

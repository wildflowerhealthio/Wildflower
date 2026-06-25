//! `POST /apps` — register a new app. Mints a fresh random id, parses the URL
//! through the write-side filter (so an open-redirect never lands in the row),
//! persists it, and returns the resulting [`AppEntry`].

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{AppEntry, AppUrl};
use crate::http::response_templates::{HandlerError, InvalidFieldBody};
use crate::http::state::AppsState;

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

/// `POST /apps` — create an app. Owner-gated by the consumer.
#[utoipa::path(
    post,
    path = "/apps",
    request_body = CreateAppBody,
    responses(
        (status = 200, description = "The created app", body = AppEntry),
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
        subtitle: body.subtitle,
        url,
        requires_tunnel: body.requires_tunnel,
    };
    let inserted = state
        .store
        .insert_app(&entry)
        .map_err(|e| HandlerError::internal("insert_app failed", e))?;
    if !inserted {
        // 21-char random id collided — vanishingly unlikely, but surface it
        // as a logged 500 rather than silently returning the existing row.
        tracing::error!("app id collision on {}", entry.id);
        return Err(HandlerError::internal(
            "insert_app id collision",
            "id already exists",
        ));
    }
    Ok(Json(entry))
}

/// Generate a fresh random id — a 21-char base62-ish alphabet has ~125 bits of
/// entropy, more than enough that a collision under sane workloads is
/// astronomically unlikely (the create path still surfaces a collision as a 500
/// to keep the guarantee blameable).
fn mint_app_id() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(21)
        .map(char::from)
        .collect()
}

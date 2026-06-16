//! `POST /apps` — register a new custom app. Mints a fresh `custom-…` id,
//! validates the URL through the write-side filter (so an open-redirect
//! never lands in the row), persists it, and returns the resulting
//! [`AppEntry`].

use std::sync::Arc;

use axum::extract::State;
use axum::routing::{post, MethodRouter};
use axum::Json;
use rand::distr::Alphanumeric;
use rand::Rng;
use serde::Deserialize;

use crate::db::CreateCustomApp;
use crate::domain::{validate_custom_url, AppEntry, AppKind};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

/// POST body — matches the TS `CreateCustomAppBodySchema`. `requiresTunnel`
/// uses the wire-camelCase the existing client speaks.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCustomAppBody {
    name: String,
    url: String,
    requires_tunnel: bool,
}

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    post(handle_create_custom_app)
}

async fn handle_create_custom_app(
    State(state): State<Arc<AppsState>>,
    Json(body): Json<CreateCustomAppBody>,
) -> Result<Json<AppEntry>, HandlerError> {
    if body.name.is_empty() {
        return Err(HandlerError::InvalidUrl {
            message: "name must not be empty".to_owned(),
        });
    }
    if let Err(e) = validate_custom_url(&body.url) {
        return Err(HandlerError::InvalidUrl {
            message: e.to_string(),
        });
    }
    let id = mint_custom_id();
    let payload = CreateCustomApp {
        id: id.clone(),
        name: body.name.clone(),
        url: body.url.clone(),
        requires_tunnel: body.requires_tunnel,
    };
    let inserted = state
        .store
        .create_custom_app(&payload)
        .map_err(|e| HandlerError::internal("create_custom_app insert failed", e))?;
    if !inserted {
        // 21-char random id collided — vanishingly unlikely, but surface it
        // as a logged 500 rather than silently returning the existing row.
        tracing::error!("custom-app id collision on {id}");
        return Err(HandlerError::internal(
            "create_custom_app id collision",
            "id already exists",
        ));
    }
    Ok(Json(AppEntry {
        id,
        name: body.name,
        // Custom apps surface their URL as the subtitle, matching TS.
        subtitle: Some(body.url),
        requires_tunnel: body.requires_tunnel,
        kind: AppKind::Custom,
        enabled: true,
    }))
}

/// Generate a fresh `custom-<21-alphanumeric>` id. Roughly matches the TS
/// `custom-${nanoid()}` shape — a 21-char alphabet of base62 has ~125 bits
/// of entropy, more than enough that a collision under sane workloads is
/// astronomically unlikely (the create path still surfaces a collision as
/// a 500 to keep the guarantee blameable).
fn mint_custom_id() -> String {
    let suffix: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(21)
        .map(char::from)
        .collect();
    format!("custom-{suffix}")
}

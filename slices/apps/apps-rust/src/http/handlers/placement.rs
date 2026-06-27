//! `PATCH /apps/{id}/placement` — homescreen placement updates that apply to
//! **every** provenance: toggle `enabled` and/or set the display `position`
//! (drag-to-reorder). Distinct from the cloud-admin `PATCH /apps/{id}`, which
//! edits a cloud app's content (name / url / …) and rejects non-cloud apps —
//! placement is a property of the registry row, so a system or self-hosted app
//! can be reordered / disabled just the same.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::App;
use crate::http::response_templates::{AppNotFoundBody, HandlerError};
use crate::http::state::AppsState;

/// PATCH body — both fields optional. `enabled` toggles the homescreen
/// visibility; `position` sets the display order. An empty body is a no-op that
/// still returns the current row (so the client can re-read).
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlacementBody {
    enabled: Option<bool>,
    position: Option<i64>,
}

/// `PATCH /apps/{id}/placement` — reorder / enable any app. Owner-gated by the
/// host. `404` if the id doesn't exist.
#[utoipa::path(
    patch,
    path = "/apps/{id}/placement",
    params(("id" = String, Path, description = "App id")),
    request_body = PlacementBody,
    responses(
        (status = 200, description = "The updated registry row", body = App),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_update_placement(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
    Json(body): Json<PlacementBody>,
) -> Result<Json<App>, HandlerError> {
    // 404 before any write: a placement patch to an unknown id is a missing
    // resource, not a silent no-op.
    if state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .is_none()
    {
        return Err(HandlerError::NotFound { id });
    }

    if let Some(enabled) = body.enabled {
        state
            .store
            .set_enabled(&id, enabled)
            .map_err(|e| HandlerError::internal("set_enabled failed", e))?;
    }
    if let Some(position) = body.position {
        state
            .store
            .set_position(&id, position)
            .map_err(|e| HandlerError::internal("set_position failed", e))?;
    }

    // Re-read so the response reflects the persisted row (and any value the
    // client didn't touch).
    let updated = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app re-read failed", e))?
        .ok_or_else(|| {
            HandlerError::internal("row vanished after placement update", format!("id={id}"))
        })?;
    Ok(Json(updated))
}

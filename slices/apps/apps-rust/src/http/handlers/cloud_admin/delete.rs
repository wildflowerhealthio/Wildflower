//! `DELETE /apps/{id}` — remove a **cloud** app row (CASCADE removes its child).
//! Unknown ids return `404`; a system / self-hosted id that exists returns
//! `409 AppNotEditable` (those kinds are not user-removable).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::Provenance;
use crate::http::response_templates::{AppNotEditableBody, AppNotFoundBody, HandlerError};
use crate::http::state::AppsState;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /apps/{id}` — remove a cloud app. Owner-gated by the host.
#[utoipa::path(
    delete,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The row was removed", body = DeletedBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "The app exists but is not a cloud app (system / self-hosted apps are not removable)", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_delete_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, HandlerError> {
    // Existence + editability first: 404 unknown, 409 non-cloud.
    let parent = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;
    if parent.provenance != Provenance::Cloud {
        return Err(HandlerError::NotEditable { id });
    }
    let deleted = state
        .store
        .delete_app(&id)
        .map_err(|e| HandlerError::internal("delete_app failed", e))?;
    if !deleted {
        // We just read the cloud parent under the same connection; it can't have
        // vanished. Surface as a logged 500 rather than a misleading 404.
        return Err(HandlerError::internal(
            "row vanished between find_app and delete_app",
            format!("id={id}"),
        ));
    }
    Ok(Json(DeletedBody { deleted: true }))
}

//! `DELETE /apps/{id}` — remove an app. What "removable" means depends on the
//! provenance:
//!
//!  - **cloud** — delete the row (CASCADE removes its child), as ever;
//!  - **self-hosted** — only an *uploaded* app (`seeded = 0`) is removable: stop
//!    its listener, delete the rows, and best-effort remove its files; a
//!    migration-seeded self-hosted app (e.g. patient-browser) stays protected
//!    with `409 AppNotEditable`;
//!  - **system** — never removable (`409 AppNotEditable`).
//!
//! Unknown ids return `404`.

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

/// `DELETE /apps/{id}` — remove a cloud app or an uploaded self-hosted app.
/// Owner-gated by the host.
#[utoipa::path(
    delete,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The row was removed", body = DeletedBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "The app exists but is not removable (system / seeded self-hosted apps)", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_delete_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, HandlerError> {
    let parent = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    match parent.provenance() {
        Provenance::Cloud => {
            let deleted = state
                .store
                .delete_app(&id)
                .map_err(|e| HandlerError::internal("delete_app failed", e))?;
            if !deleted {
                // Read under the same connection — the row can't have vanished;
                // a logged 500, not a misleading 404.
                return Err(HandlerError::internal(
                    "row vanished between find_app and delete_app",
                    format!("id={id}"),
                ));
            }
            Ok(Json(DeletedBody { deleted: true }))
        }
        Provenance::SelfHosted => delete_self_hosted(&state, &id).await,
        // System apps have no child row and are not user-removable.
        Provenance::System => Err(HandlerError::NotEditable { id }),
    }
}

/// The self-hosted arm: seeded rows are protected, uploaded rows are torn down
/// (listener stopped, rows deleted, files removed best-effort).
async fn delete_self_hosted(
    state: &Arc<AppsState>,
    id: &str,
) -> Result<Json<DeletedBody>, HandlerError> {
    let child = state
        .store
        .find_self_hosted_app(id)
        .map_err(|e| HandlerError::internal("find_self_hosted_app lookup failed", e))?
        .ok_or_else(|| {
            HandlerError::internal("self-hosted parent has no child row", format!("id={id}"))
        })?;
    if child.seeded {
        // A migration-seeded app (patient-browser) is read-only, same 409 as
        // before this route learned to delete uploads.
        return Err(HandlerError::NotEditable { id: id.to_owned() });
    }

    // Take the listener down first. A lock-poison here is logged and tolerated —
    // the user's intent is removal, and leaving the row would be worse.
    if let Err(error) = state.self_hosted.stop(id) {
        tracing::warn!(%error, app = %id, "failed to stop an uploaded self-hosted app before delete");
    }

    let deleted = state
        .store
        .delete_self_hosted_app(id)
        .map_err(|e| HandlerError::internal("delete_self_hosted_app failed", e))?;
    if !deleted {
        return Err(HandlerError::internal(
            "row vanished between find_self_hosted_app and delete_self_hosted_app",
            format!("id={id}"),
        ));
    }

    // Best-effort file removal — the row is already gone, so a leftover folder is
    // harmless (it 404s until a same-slug reinstall overwrites it).
    let dir = state.self_hosted.apps_dir().join(&child.content_folder);
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %dir.display(), "failed to remove an uploaded app's files");
        }
    }

    Ok(Json(DeletedBody { deleted: true }))
}

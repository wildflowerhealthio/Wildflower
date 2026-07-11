//! `DELETE /apps/{id}` — remove an app. What "removable" means depends on the
//! kind:
//!
//!  - **cloud** — delete the row, as ever;
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

use crate::domain::{App, AppError, SelfHostedApp};
use crate::http::errors::{AppNotEditableBody, AppNotFoundBody};
use crate::http::state::AppsState;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /apps/{id}` — remove a cloud app or an uploaded self-hosted app.
/// Owner-gated by the host.
#[utoipa::path(
    delete,
    tag = "Catalogue",
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
) -> Result<Json<DeletedBody>, AppError> {
    let app = state
        .store
        .find_app(&id)?
        .ok_or_else(|| AppError::NotFound { id: id.clone() })?;

    match &app {
        App::Cloud { .. } => {
            delete_row(&state, &id)?;
            Ok(Json(DeletedBody { deleted: true }))
        }
        App::SelfHosted { app: child, .. } => delete_self_hosted(&state, &id, child),
        // System apps are not user-removable.
        App::System { .. } => Err(AppError::NotEditable { id }),
    }
}

/// Delete the app's rows (`home_screen` + the concrete row), mapping "nothing
/// deleted" to a logged 500 — the row was just read under the same store, so it
/// can't have vanished; never a misleading 404.
fn delete_row(state: &AppsState, id: &str) -> Result<(), AppError> {
    let deleted = state.store.delete_app(id)?;
    if !deleted {
        return Err(AppError::backend(
            "row vanished between find_app and delete_app",
            format!("id={id}"),
        ));
    }
    Ok(())
}

/// The self-hosted arm: seeded rows are protected, uploaded rows are torn down
/// (listener stopped, rows deleted, files removed best-effort). The `child` record
/// came off the already-loaded app — no second lookup.
fn delete_self_hosted(
    state: &Arc<AppsState>,
    id: &str,
    child: &SelfHostedApp,
) -> Result<Json<DeletedBody>, AppError> {
    if child.seeded {
        // A migration-seeded app (patient-browser) is read-only, same 409 as
        // before this route learned to delete uploads.
        return Err(AppError::NotEditable { id: id.to_owned() });
    }

    // Take the listener down first. A lock-poison here is logged and tolerated —
    // the user's intent is removal, and leaving the row would be worse.
    if let Err(error) = state.self_hosted.stop(id) {
        tracing::warn!(%error, app = %id, "failed to stop an uploaded self-hosted app before delete");
    }

    delete_row(state, id)?;

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

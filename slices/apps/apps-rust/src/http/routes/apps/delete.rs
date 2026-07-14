//! `DELETE /apps/{id}` — remove an app. Unified across kinds: the kind is resolved
//! from the registration, so tiles and the editor need no kind to delete. The
//! **removability policy lives in the domain action** ([`actions::delete_app`]):
//!
//!  - **cloud** — removable; the action deletes the registration (the payload
//!    cascades);
//!  - **self-hosted** — only an *uploaded* app (`seeded = 0`) is removable; a
//!    migration-seeded one stays protected with `409 AppNotEditable`. After the
//!    action deletes the row, this handler runs the host-side teardown (stop the
//!    listener, best-effort remove the files) the domain can't reach;
//!  - **system** — never removable (`409 AppNotEditable`).
//!
//! Unknown ids return `404`. Success is `204 No Content`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::domain::{actions, AppConfiguration, AppsError, SelfHostedAppConfiguration};
use crate::http::errors::{AppNotEditableBody, AppNotFoundBody};
use crate::http::state::AppsState;

/// `DELETE /apps/{id}` — remove a cloud app or an uploaded self-hosted app.
/// Owner-gated by the host.
#[utoipa::path(
    delete,
    tag = "Catalogue",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "The app was removed"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "The app exists but is not removable (system / seeded self-hosted apps)", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_delete_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppsError> {
    // The action owns the removability verdict (404 unknown / 409 protected) and the
    // store delete, handing back the removed pair so this handler can run the
    // kind-specific host-side teardown the domain can't reach.
    let (_registration, configuration) = actions::delete_app(&state.store, &id)?;

    if let AppConfiguration::SelfHosted(config) = &configuration {
        teardown_self_hosted(&state, &id, config);
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Host-side teardown for a just-deleted uploaded self-hosted app: stop its listener
/// and best-effort remove its files. The row is already gone (the action deleted a
/// removable app), so this is pure cleanup — every failure is logged and tolerated.
fn teardown_self_hosted(state: &Arc<AppsState>, id: &str, config: &SelfHostedAppConfiguration) {
    // A lock-poison here is logged and tolerated — the row is already removed, and
    // leaving a stale listener is better than failing an accepted delete.
    if let Err(error) = state.self_hosted.stop(id) {
        tracing::warn!(%error, app = %id, "failed to stop an uploaded self-hosted app after delete");
    }

    // Best-effort file removal — the row is already gone, so a leftover folder is
    // harmless (it 404s until a same-slug reinstall overwrites it).
    let dir = state.self_hosted.apps_dir().join(&config.content_folder);
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %dir.display(), "failed to remove an uploaded app's files");
        }
    }
}

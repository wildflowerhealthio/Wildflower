//! `DELETE /apps/{id}` — remove an app. Unified across kinds: the kind is resolved
//! from the registration, so tiles and the editor need no kind to delete. What
//! "removable" means depends on the kind:
//!
//!  - **cloud** — delete the registration (the `cloud_apps` payload cascades);
//!  - **self-hosted** — only an *uploaded* app (`seeded = 0`) is removable: stop
//!    its listener, delete the registration (the payload cascades), and
//!    best-effort remove its files; a migration-seeded self-hosted app stays
//!    protected with `409 AppNotEditable`;
//!  - **system** — never removable (`409 AppNotEditable`).
//!
//! Unknown ids return `404`. Success is `204 No Content`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::domain::{actions, App, AppsError, SelfHostedAppConfiguration};
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
    let app = actions::get_app(&state.store, &id)?;

    match &app {
        App::Cloud(..) => {
            actions::delete_app(&state.store, &id)?;
            Ok(StatusCode::NO_CONTENT)
        }
        App::SelfHosted(_registration, config) => delete_self_hosted(&state, &id, config),
        // System apps are not user-removable.
        App::System(..) => Err(AppsError::NotEditable { id }),
    }
}

/// The self-hosted arm: seeded rows are protected, uploaded rows are torn down
/// (listener stopped, registration deleted, files removed best-effort). The
/// `config` came off the already-loaded app — no second lookup.
fn delete_self_hosted(
    state: &Arc<AppsState>,
    id: &str,
    config: &SelfHostedAppConfiguration,
) -> Result<StatusCode, AppsError> {
    if config.seeded {
        // A migration-seeded app (patient-browser) is read-only.
        return Err(AppsError::NotEditable { id: id.to_owned() });
    }

    // Take the listener down first. A lock-poison here is logged and tolerated —
    // the user's intent is removal, and leaving the row would be worse.
    if let Err(error) = state.self_hosted.stop(id) {
        tracing::warn!(%error, app = %id, "failed to stop an uploaded self-hosted app before delete");
    }

    actions::delete_app(&state.store, id)?;

    // Best-effort file removal — the row is already gone, so a leftover folder is
    // harmless (it 404s until a same-slug reinstall overwrites it).
    let dir = state.self_hosted.apps_dir().join(&config.content_folder);
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %dir.display(), "failed to remove an uploaded app's files");
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

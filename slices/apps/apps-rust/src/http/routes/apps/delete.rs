//! `DELETE /apps/{id}` — remove an app. Unified across kinds: the kind is resolved
//! from the registration, so tiles and the editor need no kind to delete. All of the
//! work — the **removability policy** and the self-hosted host-side teardown (stop the
//! listener before the row is freed, remove the serving folder after) — lives in the
//! domain action ([`actions::delete_app`], driven over the store + the
//! [`SelfHostedInstaller`](crate::domain::SelfHostedInstaller) port); this handler only
//! wires the request to it.
//!
//!  - **cloud** — removable; the registration is deleted (the payload cascades);
//!  - **self-hosted** — only an *uploaded* app (`seeded = 0`) is removable; a
//!    migration-seeded one stays protected with `409 AppNotEditable`;
//!  - **system** — never removable (`409 AppNotEditable`).
//!
//! Unknown ids return `404`. Success is `204 No Content`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::domain::{actions, AppsError};
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
    // The action owns the removability verdict (404 unknown / 409 protected), the store
    // delete, and the self-hosted teardown it brackets around it (stop before the row is
    // freed, discard the folder after) — driven over the store + the self-hosted
    // installer the state holds.
    actions::delete_app(&state.store, state.self_hosted.as_ref(), &id)?;
    Ok(StatusCode::NO_CONTENT)
}

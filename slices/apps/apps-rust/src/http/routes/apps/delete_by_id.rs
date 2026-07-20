//! `DELETE /apps/{id}` — remove an app. Unified across kinds: the kind is resolved
//! from the registration, so tiles and the editor need no kind to delete. All of the
//! work — the **removability policy** and the self-hosted host-side teardown (stop the
//! listener before the row is freed, remove the serving folder after) — lives in the
//! `AppsDeleter` capability (over the store + the
//! [`SelfHostedInstaller`](crate::domain::SelfHostedInstaller) port); this handler only
//! wires the request to it.
//!
//!  - **cloud** — removable; the registration is deleted (the payload cascades);
//!  - **self-hosted** — only an *uploaded* app (`seeded = 0`) is removable; a
//!    migration-seeded one stays protected with `409 AppNotEditable`;
//!  - **system** — never removable (`409 AppNotEditable`).
//!
//! Unknown ids return `404`. Success is `204 No Content`.

use axum::extract::Path;
use axum::http::StatusCode;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::{AppNotEditableBody, AppNotFoundBody};
use crate::live_bindings::LiveAppsDeleter;

/// `DELETE /apps/{id}` — remove a cloud app or an uploaded self-hosted app.
/// Scope-gated on `wildflower/Apps.d` through [`Scoped<LiveAppsDeleter>`].
#[utoipa::path(
    delete,
    tag = "Catalogue",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "The app was removed"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.d`", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "The app exists but is not removable (system / seeded self-hosted apps)", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_delete_app(
    deleter: Scoped<LiveAppsDeleter>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppsError> {
    // The capability owns the removability verdict (404 unknown / 409 protected),
    // the store delete, and the self-hosted teardown it brackets around it (stop
    // before the row is freed, discard the folder after).
    deleter.delete_by_id(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

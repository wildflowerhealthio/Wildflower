//! `DELETE /apps/{id}` — remove an app. Unified across kinds: the kind is resolved
//! from the registration, so tiles and the editor need no kind to delete. The
//! **removability policy** lives in the `AppsDeleter` capability; this handler only
//! wires the request to it.
//!
//!  - **cloud** — removable; the registration is deleted (the payload cascades);
//!  - **system** — never removable (`409 AppNotEditable`).
//!
//! Unknown ids return `404`. Success is `204 No Content`.

use axum::extract::Path;
use axum::http::StatusCode;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::{AppNotEditableBody, AppNotFoundBody};
use crate::live_bindings::LiveAppsDeleter;

/// `DELETE /apps/{id}` — remove a cloud app. Scope-gated on `wildflower/Apps.d`
/// through [`Scoped<LiveAppsDeleter>`].
#[utoipa::path(
    delete,
    tag = "Catalogue",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "The app was removed"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.d`", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "The app exists but is not removable (system apps)", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_delete_app(
    deleter: Scoped<LiveAppsDeleter>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppsError> {
    // The capability owns the removability verdict (404 unknown / 409 protected)
    // and the store delete.
    deleter.delete_by_id(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

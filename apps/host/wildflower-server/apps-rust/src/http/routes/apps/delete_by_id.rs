//! `DELETE /apps/{id}` — remove an app. Unknown ids return `404`. Success is
//! `204 No Content`.

use axum::extract::Path;
use axum::http::StatusCode;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::AppNotFoundBody;
use crate::live_bindings::LiveAppsDeleter;

/// `DELETE /apps/{id}` — remove an app. Scope-gated on `wildflower/Apps.d`
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
    ),
)]
pub(crate) async fn handle_delete_app(
    deleter: Scoped<LiveAppsDeleter>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppsError> {
    deleter.delete_by_id(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

//! `GET /apps/{id}` — one app: its registration, including the stored `url`
//! template. `404` if no app has the id.

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::{AppRegistration, AppsError};
use crate::http::errors::AppNotFoundBody;
use crate::live_bindings::LiveAppsReader;

/// `GET /apps/{id}` — one app. Scope-gated on `wildflower/Apps.r` through
/// [`Scoped<LiveAppsReader>`].
#[utoipa::path(
    get,
    tag = "Catalogue",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The app", body = AppRegistration),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.r`", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_app(
    reader: Scoped<LiveAppsReader>,
    Path(id): Path<String>,
) -> Result<Json<AppRegistration>, AppsError> {
    Ok(Json(reader.get(&id)?))
}

//! `GET /system-apps/{id}` — the read-only detail for a system app: the
//! registration fields plus the display-only `url` template. `404` if no *system*
//! app has the id.

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::AppNotFoundBody;
use crate::http::wire_representations::SystemAppDetail;
use crate::live_bindings::LiveAppsReader;

/// `GET /system-apps/{id}` — the system read-only detail. Scope-gated on
/// `wildflower/Apps.r` through [`Scoped<LiveAppsReader>`].
#[utoipa::path(
    get,
    tag = "System apps",
    path = "/system-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The system app detail", body = SystemAppDetail),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.r`", body = InsufficientScopeBody),
        (status = 404, description = "No system app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_system_app(
    reader: Scoped<LiveAppsReader>,
    Path(id): Path<String>,
) -> Result<Json<SystemAppDetail>, AppsError> {
    let (registration, config) = reader.system(&id)?;
    Ok(Json(SystemAppDetail::from((&registration, &config))))
}

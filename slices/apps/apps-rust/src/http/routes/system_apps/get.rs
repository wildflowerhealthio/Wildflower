//! `GET /system-apps/{id}` — the read-only detail for a system app: the
//! registration fields plus the display-only `url` template. `404` if no *system*
//! app has the id.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;

use crate::domain::{actions, AppError, SystemAppDetail};
use crate::http::errors::AppNotFoundBody;
use crate::http::state::AppsState;

/// `GET /system-apps/{id}` — the system read-only detail. Owner-gated by the host.
#[utoipa::path(
    get,
    tag = "System apps",
    path = "/system-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The system app detail", body = SystemAppDetail),
        (status = 404, description = "No system app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_system_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<SystemAppDetail>, AppError> {
    let app = actions::get_system_app(&state.store, &id)?;
    Ok(Json(SystemAppDetail::from(&app)))
}

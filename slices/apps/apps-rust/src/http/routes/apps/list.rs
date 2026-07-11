//! `GET /apps` — return the catalogue: every registry app projected to
//! [`AppListEntry`], already ordered by `position` (the store reads the
//! cross-kind `apps_view` + the `home_screen` ordering). The wire shape omits the
//! request-resolved launch URL (materialized per-request at launch; see
//! [`AppListEntry`]).

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::{AppError, AppListEntry};
use crate::http::state::AppsState;

/// `GET /apps` — the full catalogue in display order. Gating is applied by the
/// host (the slice exposes one router; there is no longer an ungated public
/// surface here).
#[utoipa::path(
    get,
    tag = "Catalogue",
    path = "/apps",
    responses(
        (status = 200, description = "Every app in the registry, ordered by position", body = [AppListEntry]),
    ),
)]
pub(crate) async fn handle_list_apps(
    State(state): State<Arc<AppsState>>,
) -> Result<Json<Vec<AppListEntry>>, AppError> {
    let apps = state.store.list_apps()?;
    Ok(Json(apps.iter().map(AppListEntry::from).collect()))
}

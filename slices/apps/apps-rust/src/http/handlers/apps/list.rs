//! `GET /apps` — return the catalogue: every parent registry row projected to
//! [`AppListEntry`], already ordered by `position` (the store does the JOIN +
//! ORDER BY). The wire shape omits the launch `url` (resolved per-request at
//! launch; see [`AppListEntry`]).

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::AppListEntry;
use crate::http::response_templates::HandlerError;
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
) -> Result<Json<Vec<AppListEntry>>, HandlerError> {
    let apps = state
        .store
        .list_apps()
        .map_err(|e| HandlerError::internal("list_apps lookup failed", e))?;
    Ok(Json(apps.iter().map(AppListEntry::from).collect()))
}

//! `GET /apps` — return every persisted app row (bundled + custom) as a
//! list of [`AppEntry`]s. Bundled rows are layered with the registry
//! metadata; custom rows project their own columns. The order is the seed
//! order followed by the insertion order of custom rows (rowid).

use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, MethodRouter};
use axum::Json;

use super::super::build_entry::build_entry;
use crate::domain::AppEntry;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    get(handle_list_apps)
}

async fn handle_list_apps(
    State(state): State<Arc<AppsState>>,
) -> Result<Json<Vec<AppEntry>>, HandlerError> {
    let rows = state
        .store
        .list_apps()
        .map_err(|e| HandlerError::internal("list_apps lookup failed", e))?;
    let entries: Vec<AppEntry> = rows.iter().filter_map(build_entry).collect();
    Ok(Json(entries))
}

//! `GET /apps` — return every persisted app row as a list of [`AppEntry`].
//! With the row type equal to the wire type there's no projection step:
//! the store hands back `Vec<AppEntry>` and the handler serializes it
//! verbatim.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::AppEntry;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    get(handle_list_apps)
}

async fn handle_list_apps(
    State(state): State<Arc<AppsState>>,
) -> Result<Json<Vec<AppEntry>>, HandlerError> {
    let entries = state
        .store
        .list_apps()
        .map_err(|e| HandlerError::internal("list_apps lookup failed", e))?;
    Ok(Json(entries))
}

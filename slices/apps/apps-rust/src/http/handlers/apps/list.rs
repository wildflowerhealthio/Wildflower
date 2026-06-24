//! `GET /apps` — return every persisted app row as a list of
//! [`AppListEntry`]. Internals (locally served) come first, then externals
//! (user-editable), both in their own seed/insertion order. The wire shape
//! deliberately **omits the launch `url`**: the launch endpoint is the only
//! thing that resolves a URL (and only at request time, so a forwarded
//! caller and a loopback caller get the right origin), so the catalogue
//! doesn't need to predict it.
//!
//! When the user's `apps` row carries the same id as an internal seed
//! (only possible when a pre-migration-002 edit prevented the guarded
//! DELETE in `002_internal_apps_table.sql` from running), the internal
//! wins — it's the live, locally-served target.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::AppListEntry;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

/// `GET /apps` — the full catalogue. Reachable unauthenticated by embedded
/// webviews and iframes that can't easily carry a bearer token.
#[utoipa::path(
    get,
    path = "/apps",
    responses(
        (status = 200, description = "Every persisted app, in seed/insertion order", body = [AppListEntry]),
    ),
)]
pub(crate) async fn handle_list_apps(
    State(state): State<Arc<AppsState>>,
) -> Result<Json<Vec<AppListEntry>>, HandlerError> {
    let internals = state
        .internal_apps
        .list()
        .map_err(|e| HandlerError::internal("list internal_apps lookup failed", e))?;
    let externals = state
        .store
        .list_apps()
        .map_err(|e| HandlerError::internal("list_apps lookup failed", e))?;
    let host = &state.internal_apps_loopback_host;
    let internal_ids: HashSet<&str> = internals.iter().map(|i| i.id.as_str()).collect();
    let mut entries: Vec<AppListEntry> = internals
        .iter()
        .map(|i| AppListEntry::from(i.to_app_entry(host)))
        .collect();
    entries.extend(
        externals
            .into_iter()
            .filter(|e| !internal_ids.contains(e.id.as_str()))
            .map(AppListEntry::from),
    );
    Ok(Json(entries))
}

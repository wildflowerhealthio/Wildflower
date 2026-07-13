//! `GET /apps` — return the catalogue: every app's [`AppRegistration`], already
//! ordered by `position` (the store reads `app_registrations ORDER BY position`,
//! join-free). It is the registry, not the homescreen, so disabled rows are
//! included. Uniform (no `provenance` union): everything the homescreen tile
//! renders is on the registration; per-kind payload (`url`, `launchPath`) is an
//! editor concern read on a per-kind detail lookup.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::{actions, AppRegistration, AppsError};
use crate::http::state::AppsState;

/// `GET /apps` — the full registry in display order. Owner-gated by the host.
#[utoipa::path(
    get,
    tag = "Catalogue",
    path = "/apps",
    responses(
        (status = 200, description = "Every app in the registry, ordered by position", body = [AppRegistration]),
    ),
)]
pub(crate) async fn handle_list_apps(
    State(state): State<Arc<AppsState>>,
) -> Result<Json<Vec<AppRegistration>>, AppsError> {
    Ok(Json(actions::list_registrations(&state.store)?))
}

//! `GET /apps` — return every persisted app row as a list of [`AppEntry`].
//! With the row type equal to the wire type there's no projection step:
//! the store hands back `Vec<AppEntry>` and the handler serializes it
//! verbatim.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::AppEntry;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

/// `GET /apps` — the full catalogue. Reachable unauthenticated by embedded
/// webviews and iframes that can't easily carry a bearer token.
#[utoipa::path(
    get,
    path = "/apps",
    responses(
        (status = 200, description = "Every persisted app, in seed/insertion order", body = [AppEntry]),
    ),
)]
pub(crate) async fn handle_list_apps(
    State(state): State<Arc<AppsState>>,
) -> Result<Json<Vec<AppEntry>>, HandlerError> {
    let entries = state
        .store
        .list_apps()
        .map_err(|e| HandlerError::internal("list_apps lookup failed", e))?;
    Ok(Json(entries))
}

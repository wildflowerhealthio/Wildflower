//! `PUT /home-screen` — atomically replace the homescreen ordering **and**
//! `enabled` flags for the whole registry, every provenance, in one transaction.
//!
//! The body is the full ordered list `[{ id, enabled }]`: an entry's index in
//! the array *is* its new display `position`. The dense-`0..n` /
//! single-writer / drag-reorder-bug rationale is canonical on
//! [`AppsStore::replace_home_screen`](crate::db::AppsStore::replace_home_screen),
//! which this handler is the sole caller of. The cloud-admin `PATCH /apps/{id}`
//! edits only a cloud app's *content* — homescreen curation lives here.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::AppListEntry;
use crate::http::response_templates::{HandlerError, InvalidHomeScreenBody};
use crate::http::state::AppsState;

/// One entry in the `PUT /home-screen` body: an app id and its desired `enabled`
/// flag. The entry's index in the array is its new display `position`. Matches
/// the TS `HomeScreenEntrySchema`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeScreenEntry {
    id: String,
    enabled: bool,
}

/// `PUT /home-screen` — atomically reorder + enable/disable every app. Owner-gated
/// by the host. The body must list **every** registry app exactly once (its order
/// is the new display order); a missing / duplicated / unknown id is
/// `400 InvalidHomeScreen`. Returns the resulting catalogue in its new order.
#[utoipa::path(
    put,
    tag = "Home screen",
    path = "/home-screen",
    request_body = [HomeScreenEntry],
    responses(
        (status = 200, description = "The whole catalogue in its new order", body = [AppListEntry]),
        (status = 400, description = "The body wasn't an exact permutation of the registry", body = InvalidHomeScreenBody),
    ),
)]
pub(crate) async fn handle_replace_home_screen(
    State(state): State<Arc<AppsState>>,
    Json(body): Json<Vec<HomeScreenEntry>>,
) -> Result<Json<Vec<AppListEntry>>, HandlerError> {
    // The home screen *is* the whole registry, reordered — so the body must be an
    // exact permutation of the current ids. `replace_home_screen` validates that
    // against the live registry **and** renumbers in one transaction (the
    // dense-`0..n` guarantee can't be split across two lock acquisitions), and
    // returns the resulting catalogue. `Ok(None)` means the body wasn't an exact
    // permutation → `400 InvalidHomeScreen`.
    let entries: Vec<(String, bool)> = body.into_iter().map(|e| (e.id, e.enabled)).collect();
    match state
        .store
        .replace_home_screen(&entries)
        .map_err(|e| HandlerError::internal("replace_home_screen failed", e))?
    {
        Some(updated) => Ok(Json(updated.iter().map(AppListEntry::from).collect())),
        None => Err(HandlerError::InvalidHomeScreen {
            message: "home-screen body must list every app exactly once".to_owned(),
        }),
    }
}

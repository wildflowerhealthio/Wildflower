//! `PUT /home-screen` — atomically replace the homescreen ordering **and**
//! `enabled` flags for the whole registry, every provenance, in one transaction.
//!
//! The body is the full ordered list `[{ id, enabled }]`: an entry's index in
//! the array *is* its new display `position`, so the result is a dense `0..n`
//! permutation — well-ordered by construction, with no per-row "set this one's
//! position" write that could leave two rows sharing a position (the cause of
//! the drag-to-reorder jumping). The write is one transaction, so a swap is
//! never observed half-applied.
//!
//! This is the single writer of `position` + `enabled`. The cloud-admin
//! `PATCH /apps/{id}` edits only a cloud app's *content* (name / url / subtitle /
//! requiresTunnel) — homescreen curation lives here.

use std::collections::HashSet;
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
    // exact permutation of the current ids. Validating up front (rather than
    // letting unmatched UPDATEs silently no-op) is what guarantees the result is
    // a dense `0..n` with nothing dropped, duplicated, or invented.
    let current = state
        .store
        .list_app_entries()
        .map_err(|e| HandlerError::internal("list_app_entries lookup failed", e))?;
    let current_ids: HashSet<&str> = current.iter().map(|e| e.id.as_str()).collect();
    let body_ids: HashSet<&str> = body.iter().map(|e| e.id.as_str()).collect();
    if body.len() != current.len() || body_ids != current_ids {
        return Err(HandlerError::InvalidHomeScreen {
            message: "home-screen body must list every app exactly once".to_owned(),
        });
    }

    let entries: Vec<(String, bool)> = body.into_iter().map(|e| (e.id, e.enabled)).collect();
    state
        .store
        .replace_home_screen(&entries)
        .map_err(|e| HandlerError::internal("replace_home_screen failed", e))?;

    let updated = state
        .store
        .list_app_entries()
        .map_err(|e| HandlerError::internal("list_app_entries re-read failed", e))?;
    Ok(Json(updated))
}

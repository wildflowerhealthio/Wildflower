//! `PUT /home-screen` — atomically replace the homescreen ordering **and**
//! `enabled` flags for the whole registry, every kind, in one transaction.
//!
//! The body is the full ordered list `[{ id, enabled }]`: an entry's index in
//! the array *is* its new display `position`. The dense-`0..n` /
//! single-writer / drag-reorder-bug rationale is canonical on the
//! [`AppsStore::replace_home_screen`](crate::domain::AppsStore::replace_home_screen)
//! port method (the [`replace_home_screen`](crate::domain::actions) action this
//! handler calls maps its non-permutation `None` onto `400 InvalidHomeScreen`).
//! The per-kind `PUT /cloud-apps/{id}` etc. edit an app's *content* — homescreen
//! curation lives here.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{actions, AppError, AppRegistration};
use crate::http::errors::InvalidHomeScreenBody;
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
        (status = 200, description = "The whole registry in its new order", body = [AppRegistration]),
        (status = 400, description = "The body wasn't an exact permutation of the registry", body = InvalidHomeScreenBody),
    ),
)]
pub(crate) async fn handle_replace_home_screen(
    State(state): State<Arc<AppsState>>,
    Json(body): Json<Vec<HomeScreenEntry>>,
) -> Result<Json<Vec<AppRegistration>>, AppError> {
    // The home screen *is* the whole registry, reordered — so the body must be an
    // exact permutation of the current ids. The `replace_home_screen` action's
    // store validates that against the live registry **and** renumbers in one
    // transaction (the dense-`0..n` guarantee can't be split across two lock
    // acquisitions), and the action maps a non-permutation onto
    // `400 InvalidHomeScreen`.
    let entries: Vec<(String, bool)> = body.into_iter().map(|e| (e.id, e.enabled)).collect();
    let updated = actions::replace_home_screen(&state.store, &entries)?;
    Ok(Json(updated))
}

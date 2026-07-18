//! `PUT /home-screen` — atomically replace the homescreen ordering **and**
//! `onHomescreen` flags for the whole registry, every kind, in one transaction.
//!
//! The body is the full ordered list `[{ id, onHomescreen }]`: an entry's index in
//! the array *is* its new display `position`. The dense-`0..n` /
//! single-writer / drag-reorder-bug rationale is canonical on the
//! [`AppsStore::replace_placements`](crate::domain::AppsStore::replace_placements)
//! port method (the [`AppsEditor::home_screen`](crate::domain::capabilities) call
//! this handler makes maps its non-permutation `None` onto `400 InvalidHomeScreen`).
//! The per-kind `PUT /cloud-apps/{id}` etc. edit an app's *content* — homescreen
//! curation lives here.

use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::{AppRegistration, AppsError};
use crate::http::errors::InvalidHomeScreenBody;
use crate::state::AppsEditorCap;

/// One entry in the `PUT /home-screen` body: an app id and its desired
/// `onHomescreen` flag. The entry's index in the array is its new display
/// `position`. Matches the TS `HomeScreenEntrySchema`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HomeScreenEntry {
    id: String,
    on_homescreen: bool,
}

/// `PUT /home-screen` — atomically reorder + enable/disable every app. Scope-gated
/// on `wildflower/Apps.u` through [`Scoped<AppsEditorCap>`]. The body must list
/// **every** registry app exactly once (its order is the new display order); a
/// missing / duplicated / unknown id is `400 InvalidHomeScreen`. Returns the
/// resulting catalogue in its new order.
#[utoipa::path(
    put,
    tag = "Home screen",
    path = "/home-screen",
    request_body = [HomeScreenEntry],
    responses(
        (status = 200, description = "The whole registry in its new order", body = [AppRegistration]),
        (status = 400, description = "The body wasn't an exact permutation of the registry", body = InvalidHomeScreenBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.u`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_replace_home_screen(
    editor: Scoped<AppsEditorCap>,
    Json(body): Json<Vec<HomeScreenEntry>>,
) -> Result<Json<Vec<AppRegistration>>, AppsError> {
    // The home screen *is* the whole registry, reordered — so the body must be an
    // exact permutation of the current ids. The `home_screen` capability's store
    // validates that against the live registry **and** renumbers in one transaction
    // (the dense-`0..n` guarantee can't be split across two lock acquisitions), and
    // maps a non-permutation onto `400 InvalidHomeScreen`.
    let entries: Vec<(String, bool)> = body.into_iter().map(|e| (e.id, e.on_homescreen)).collect();
    Ok(Json(editor.home_screen(&entries)?))
}

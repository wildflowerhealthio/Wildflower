//! `GET /apps` — return the catalogue: every app's [`AppRegistration`], already
//! ordered by `position` (the store reads `app_registrations ORDER BY position`,
//! join-free). It is the registry, not the homescreen, so disabled rows are
//! included. Uniform (no `provenance` union): everything the homescreen tile
//! renders is on the registration; per-kind payload (`url`, `launchPath`) is an
//! editor concern read on a per-kind detail lookup.

use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::{AppRegistration, AppsError};
use crate::state::AppsReaderCap;

/// `GET /apps` — the full registry in display order. Scope-gated on
/// `wildflower/Apps.r` through [`Scoped<AppsReaderCap>`]; the host wraps the router
/// with the bearer gate that inserts the caller's scope claims.
#[utoipa::path(
    get,
    tag = "Catalogue",
    path = "/apps",
    responses(
        (status = 200, description = "Every app in the registry, ordered by position", body = [AppRegistration]),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.r`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_list_apps(
    reader: Scoped<AppsReaderCap>,
) -> Result<Json<Vec<AppRegistration>>, AppsError> {
    Ok(Json(reader.list()?))
}

//! HTTP routes for the databases slice — the three `/databases` endpoints as one
//! [`openapi_router`]. The folder tree mirrors the URL tree (`databases/` for the
//! `/databases` segment, one file per operation); the served routes and the
//! OpenAPI spec come from the same `#[utoipa::path]`-annotated handlers.
//! `GET /databases/{id}` (download) and `DELETE /databases/{id}` share a path, so
//! `routes!` merges them into one path-item entry.

mod databases;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::DatabasesState;

/// The whole databases surface as an `OpenApiRouter` — the spec-bearing inner of
/// [`super::router`]. The host wraps the built router with its authN gate;
/// download/delete additionally require the target database's declared
/// `read_scope`/`delete_scope` (see [`crate::http::capabilities`]).
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<DatabasesState>> {
    OpenApiRouter::new()
        .routes(routes!(databases::list_all::handle_list_databases))
        .routes(routes!(
            databases::download_by_id::handle_download_database,
            databases::delete_by_id::handle_delete_database
        ))
}

#[cfg(test)]
mod tests;

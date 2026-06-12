//! Owner-scoped `/grants` management routes — list, fetch, and revoke standing
//! client grants. One module per route handler (`list`, `get`, `revoke`), each
//! exposing a `MethodRouter`; `router()` is the only path table. The two
//! methods on `/grants/{id}` (GET + DELETE) are merged here onto the shared
//! path.

mod get;
mod list;
mod revoke;

use axum::Router;

pub fn router() -> Router {
    Router::new()
        .route("/grants", list::route())
        .route("/grants/{id}", get::route().merge(revoke::route()))
}

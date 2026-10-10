//! Owner-scoped `/grants` management routes — list, fetch, and revoke standing
//! client grants. One module per route handler (`list_all`, `get_by_id`,
//! `revoke_by_id`), each exposing a `MethodRouter`; `router()` is the only path
//! table. The two methods on `/grants/{id}` (GET + DELETE) are merged here onto
//! the shared path.

mod get_by_id;
mod list_all;
mod revoke_by_id;

use std::sync::Arc;

use axum::Router;

use crate::http::state::GatekeeperState;

pub fn router() -> Router<Arc<GatekeeperState>> {
    Router::new().route("/grants", list_all::route()).route(
        "/grants/{id}",
        get_by_id::route().merge(revoke_by_id::route()),
    )
}

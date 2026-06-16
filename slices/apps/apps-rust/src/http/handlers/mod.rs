//! HTTP handlers for the apps slice. Split into two route tables — `apps`
//! (public: list + launch) and `apps_admin` (write surface) — so the
//! consumer can wrap them with different middleware.

mod apps;
mod apps_admin;
mod build_entry;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AppsState;

pub fn public_router() -> Router<Arc<AppsState>> {
    Router::new().merge(apps::router())
}

pub fn admin_router() -> Router<Arc<AppsState>> {
    Router::new().merge(apps_admin::router())
}

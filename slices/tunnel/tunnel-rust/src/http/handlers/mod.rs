use std::sync::Arc;

use axum::Router;

use crate::TunnelState;

mod tunnel;

pub fn router() -> Router<Arc<TunnelState>> {
    Router::new().merge(tunnel::router())
}

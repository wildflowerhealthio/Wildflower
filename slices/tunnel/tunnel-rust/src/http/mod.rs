//! The tunnel slice's HTTP surface. The only crate-facing surface is
//! [`router`] and [`TunnelState`]; the handler files are private
//! implementation detail behind the route table.

mod handlers;
mod response_templates;
mod state;

pub use state::TunnelState;

use std::sync::Arc;

use axum::Router;

/// Build the tunnel's `/tunnel` router (GET + PUT) over a [`TunnelState`]. The
/// module owns its mount path so the caller just `.merge()`s.
pub fn router(state: Arc<TunnelState>) -> Router {
    handlers::router().with_state(state)
}

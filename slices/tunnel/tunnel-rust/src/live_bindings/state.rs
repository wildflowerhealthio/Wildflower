//! The shared tunnel runtime state — the router state every handler is built
//! over, and the composition point that lifts the [`TunnelDaemon`] out into the
//! scope-gated capabilities. It lives at the crate root (not under
//! [`crate::http`]) deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it,
//! and `domain/` must not depend on `crate::http`.
//!
//! The capability-binding `FixedScopeCapability` impl lives in the sibling
//! [`tunnel_settings_reader`](super::tunnel_settings_reader) module: it lifts the
//! daemon handle out of the state, so the capabilities in `domain/` never name
//! the router state.

use std::sync::Arc;

use crate::domain::TunnelDaemon;

/// Shared state threaded through the tunnel handlers and lifted into the
/// scope-gated capabilities.
///
/// The [`TunnelDaemon`] is held behind an [`Arc`] so a capability binding can
/// lift a cheap handle to it out of the state (the daemon owns a `watch`
/// channel and a cancel token and is not itself `Clone`).
pub struct TunnelState {
    pub(crate) daemon: Arc<TunnelDaemon>,
}

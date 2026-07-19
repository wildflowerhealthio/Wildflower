//! The shared tunnel runtime state — the router state every handler is built
//! over, and the composition point that lifts the concrete
//! [`SqliteTunnelStore`] adapter + the [`TunnelDaemon`] out into the scope-gated
//! capabilities. It lives at the crate root (not under [`crate::http`])
//! deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it,
//! and `domain/` must not depend on `crate::http`.
//!
//! The capability-binding `FixedScopeCapability` impls live in the sibling
//! [`tunnel_settings_reader`](super::tunnel_settings_reader) /
//! [`tunnel_settings_editor`](super::tunnel_settings_editor) modules: they name
//! the concrete [`SqliteTunnelStore`] and lift the store + daemon handles out of
//! the state, so the generic, store-agnostic capabilities in `domain/` never
//! mention a concrete adapter.

use std::sync::Arc;

use crate::db::SqliteTunnelStore;
use crate::domain::TunnelDaemon;

/// Shared state threaded through the tunnel handlers and lifted into the
/// scope-gated capabilities. Holds the **concrete** [`SqliteTunnelStore`]
/// adapter (not `Arc<dyn TunnelStore>` or a generic): the port abstraction lives
/// in the domain `actions` / capabilities the handlers call, so the HTTP state
/// and axum wiring stay monomorphic.
///
/// The [`TunnelDaemon`] is held behind an [`Arc`] so a capability binding can
/// lift a cheap handle to it out of the state (the daemon owns a `Mutex` +
/// `watch` channels and is not itself `Clone`).
pub struct TunnelState {
    pub(crate) store: SqliteTunnelStore,
    pub(crate) daemon: Arc<TunnelDaemon>,
}

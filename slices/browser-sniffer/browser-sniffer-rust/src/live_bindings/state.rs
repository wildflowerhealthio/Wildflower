//! The shared sniffer runtime state — the router state every handler is built
//! over. Lives at the crate root (not under [`crate::http`]) so the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it
//! through the per-capability bindings in the parent
//! [`live_bindings`](super) module without `domain/` depending on
//! `crate::http`. Mirrors `collector-rust`'s layout.

use std::sync::Arc;

use crate::domain::{SnifferEvents, SnifferWebviewHandle};

/// Shared state threaded through the `/sniffer` handlers and lifted into the
/// scope-gated capabilities. Handlers reach it solely through a `Scoped<…>`
/// capability.
pub struct SnifferState {
    /// The host's webview port. Held as the trait object the host handed in;
    /// each capability binding lifts a clone of the `Arc` out of the state.
    pub(crate) handle: Arc<dyn SnifferWebviewHandle>,
    /// The event stream the host publishes into and the WebSocket fans out
    /// from. Cheap to clone (internally reference-counted).
    pub(crate) events: SnifferEvents,
}

impl SnifferState {
    #[must_use]
    pub fn new(handle: Arc<dyn SnifferWebviewHandle>, events: SnifferEvents) -> Self {
        SnifferState { handle, events }
    }
}

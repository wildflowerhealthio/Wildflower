//! `browser-sniffer-rust` — the browser-sniffer slice's HTTP surface: the
//! `/sniffer` control endpoints (open/navigate the sniffer webview, set its
//! status subtitle, re-present it, forward page actions and cancellations,
//! dispose) plus the `/sniffer/events` WebSocket streaming the sniffed pages'
//! captured activity. It replaces the collector's Tauri `BRIDGE_EVENT` control
//! and data planes, so any HTTP client holding the right scopes — the SPA, or
//! a browser on another device reaching the phone through the tunnel — can
//! drive a collection run.
//!
//! Pure Axum, no Tauri: the host implements the [`SnifferWebviewHandle`] port
//! (the Tauri host does so over `tauri-plugin-native-webview` in
//! `browser-sniffer-tauri-rust`) and publishes validated page events and
//! synthesized lifecycle events into the [`SnifferEvents`] channel this crate
//! fans out over the WebSocket.
//!
//! Layered like `collector-rust` / `tunnel-rust`:
//!
//!  - [`domain`] — the port, the `WebViewSource` validation, the event seam,
//!    the failure vocabulary, and the scope-gated capabilities.
//!  - [`live_bindings`] — the router state
//!    ([`SnifferState`](live_bindings::state::SnifferState)) at the crate
//!    root, and the per-capability bindings.
//!  - [`http`] — the slice's router; the REST wire contract is pinned from
//!    both sides by the committed OpenAPI snapshot, the WebSocket contract by
//!    the TS message schemas + Rust tag drift-guards.
//!
//! CONCURRENCY (deliberate, inherited from the bridge): there is one sniffer
//! webview per host and no run lease — two clients driving `/sniffer`
//! simultaneously interleave on it exactly as two bridge senders would have.
//! The event stream is fan-out, so each client sees the union. A lease (409
//! `SnifferBusy`) is a tracked follow-up if multi-client drive ever becomes a
//! real flow; today the driving client is one collector runner at a time.

pub mod domain;
pub mod http;
// The shared runtime state lives at the crate root (not under `http`) so the
// scope-gated `domain/` capabilities can be built from it without `domain/`
// depending on `crate::http`. Mirrors collector-rust's layout.
pub(crate) mod live_bindings;

use std::sync::Arc;

use axum::Router;

pub use domain::capabilities::grantable_sniffer_scopes;
pub use domain::{SnifferEvents, SnifferWebviewHandle};
pub use http::openapi_spec;
pub use live_bindings::state::SnifferState;

/// Build the sniffer router over the host-implemented webview `handle` and the
/// event stream the host publishes into, mirroring `collector-rust`'s
/// `setup_collector`.
///
/// The returned router carries no middleware, but every endpoint is
/// scope-gated per operation (the handlers take a `Scoped<…>` capability). The
/// consumer MUST still wrap it with its auth gate (the Tauri host applies
/// `layer_router_with_gatekeeper_auth_gating`) — that gate inserts the
/// `ScopeClaims` the capabilities read, so an unwrapped router fails closed
/// with a 500 rather than admitting an unauthenticated caller.
pub fn setup_browser_sniffer(
    handle: Arc<dyn SnifferWebviewHandle>,
    events: SnifferEvents,
) -> Router {
    http::router(Arc::new(SnifferState::new(handle, events)))
}

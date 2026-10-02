//! The Wildflower server: the loopback API every slice mounts on, composed by
//! [`set_up`] and served by [`WildflowerServer::serve`].
//!
//! [`set_up`] opens the host's databases, sets up each server slice
//! (gatekeeper, FHIR R4, OHIF, collector, tunnel, apps, databases), gates them,
//! wraps them in the loopback owner trust, the loopback-peer gate, the CORS
//! policy and the forwarded-request observer, and binds the loopback port.
//! [`WildflowerServer::serve`] then serves the result until its shutdown token
//! is cancelled.
//!
//! The crate has no `tauri` dependency. What the host derives at build time or
//! from its platform paths arrives in [`WildflowerServerConfig`]; the host's
//! native adapters and the channels its bridge reads arrive in [`HostPorts`];
//! the channels the host watches the server through arrive in
//! [`ServerObservers`].
//!
//! Layered like the other Rust slices:
//!
//!  - `config` — the host's inputs above, at the crate root like
//!    `gatekeeper-rust`'s `config`.
//!  - `adapters` — other slices' ports implemented here, where both sides are
//!    in reach: apps' `AppLaunchScopes` from gatekeeper's OAuth clients, and
//!    the tunnel's `HealthProbe` over `reqwest`.
//!  - `http` — the server's own middleware (CORS, the loopback owner trust,
//!    the forwarded-request report) and the unmatched-route `404`.
//!  - `live_bindings` — [`set_up`] and [`WildflowerServer`], and HFS's base URL
//!    following the tunnel's public host.

mod adapters;
mod config;
mod http;
mod live_bindings;

pub use config::{HostPorts, ServerObservers, WildflowerServerConfig};
pub use live_bindings::{set_up, WildflowerServer};

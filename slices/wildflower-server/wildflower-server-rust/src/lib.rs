//! The Wildflower server: the loopback API every slice mounts on, composed by
//! [`set_up`] and served by [`WildflowerServer::serve`].
//!
//! [`set_up`] opens the host's databases, sets up each server slice
//! (gatekeeper, FHIR R4, OHIF, collector, request log, apps, databases), gates
//! them, wraps them in the loopback owner trust, the loopback-peer gate, the
//! CORS policy and the forwarded-request observer, starts the tunnel and the
//! reachability monitor, and binds the loopback port.
//! [`WildflowerServer::serve`] then serves the result until its shutdown token
//! is cancelled; the tunnel and the monitor run for as long as it serves.
//!
//! The crate has no `tauri` dependency. What the host derives at build time or
//! from its platform paths arrives in [`WildflowerServerConfig`]; the host's
//! native adapters and the channels its bridge reads arrive in [`HostPorts`];
//! the channels the host watches the server through arrive in
//! [`ServerObservers`], among them the [`ServerHealth`] the reachability
//! monitor reads from the server's own `/health` through its public origin.
//!
//! Layered like the other Rust slices:
//!
//!  - `config` — the host's inputs above, at the crate root like
//!    `gatekeeper-rust`'s `config`.
//!  - `domain` — [`ServerHealth`] and the reachability monitor that publishes
//!    it, through its `HealthProbe` port.
//!  - `adapters` — ports implemented here, where both sides are in reach:
//!    apps' `AppLaunchScopes` from gatekeeper's OAuth clients, and the
//!    monitor's `HealthProbe` over `reqwest`.
//!  - `http` — the server's own middleware (CORS, the loopback owner trust,
//!    the forwarded-request report), the `/health` checks and the
//!    unmatched-route `404`.
//!  - `live_bindings` — [`set_up`] and [`WildflowerServer`].

mod adapters;
mod config;
mod domain;
mod http;
mod live_bindings;

pub use config::{HostPorts, ServerObservers, WildflowerServerConfig};
pub use domain::server_health::ServerHealth;
pub use live_bindings::{set_up, WildflowerServer};

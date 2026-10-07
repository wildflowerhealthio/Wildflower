//! The server's own rules about itself, free of HTTP clients and stores:
//!
//! - [`server_health`] — [`ServerHealth`](server_health::ServerHealth), whether
//!   the server's `/health` answers through its public origin, and with what.
//! - [`reachability_monitor`] — the task that asks, on a cadence, through the
//!   [`HealthProbe`](reachability_monitor::HealthProbe) port.

pub(crate) mod reachability_monitor;
pub(crate) mod server_health;

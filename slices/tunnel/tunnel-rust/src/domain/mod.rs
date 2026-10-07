//! Pure tunnel domain types — no rathole coupling — plus the [`TunnelDaemon`]
//! that runs the tunnel and the [`HealthStatus`](shared_structures_rust::health_check::HealthStatus)
//! it publishes.

mod public_host;
mod relay_client;
mod tunnel_daemon;

pub use public_host::{public_origin_url, InvalidPublicHost};
pub use relay_client::{RelayClient, RelaySettings};
pub use tunnel_daemon::TunnelDaemon;

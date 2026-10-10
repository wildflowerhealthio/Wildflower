//! Pure tunnel domain types — no rathole coupling beyond the
//! [`TunnelStream`] it hands over — plus the [`TunnelDaemon`] that runs the
//! tunnel and the [`HealthStatus`](wildflowerhealthio_shared_structures::health_check::HealthStatus)
//! it publishes.

mod public_origin;
mod relay_client;
mod tunnel_daemon;

pub use public_origin::{public_origin_url, InvalidDomain};
pub use relay_client::{RelayClient, RelaySettings, TunnelStream};
pub use tunnel_daemon::TunnelDaemon;

//! Pure tunnel domain types — no axum or rathole coupling in the wire contract
//! — plus [`TunnelError`], the failure vocabulary the HTTP layer renders, the
//! [`TunnelDaemon`] that runs the tunnel, and the [`TunnelLiveness`] it
//! publishes.

pub(crate) mod capabilities;
mod public_host;
mod relay_client;
mod tunnel_daemon;
mod tunnel_error;
mod tunnel_liveness;

pub use capabilities::grantable_tunnel_scopes;
pub use public_host::{public_origin_url, InvalidPublicHost};
pub use relay_client::{RelayClient, RelaySettings};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_error::TunnelError;
pub use tunnel_liveness::{TunnelLiveness, TunnelStatus};

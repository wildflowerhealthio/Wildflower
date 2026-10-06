//! Pure tunnel domain types — no diesel, axum, or rathole coupling in the wire
//! contract — plus [`TunnelError`], the failure vocabulary the HTTP layer
//! renders, and the [`TunnelDaemon`] that runs the tunnel.

pub(crate) mod capabilities;
mod public_host;
mod relay_client;
mod tunnel_daemon;
mod tunnel_error;

pub use capabilities::grantable_tunnel_scopes;
pub use public_host::{public_origin_url, InvalidPublicHost};
pub use relay_client::{RelayClient, RelaySettings};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_error::TunnelError;

//! Pure tunnel domain types — no diesel, axum, or rathole coupling in the wire
//! contract — plus [`TunnelError`], the failure vocabulary the HTTP layer
//! renders.

mod relay_client;
mod tunnel_daemon;
mod tunnel_error;
mod tunnel_settings;

pub use relay_client::{RelayClient, RelaySettings};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_error::TunnelError;
pub use tunnel_settings::TunnelSettings;

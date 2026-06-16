//! Pure tunnel domain types — no rusqlite, axum, or rathole coupling.

mod relay_client;
mod tunnel_daemon;
mod tunnel_settings;

pub use relay_client::{RelayClient, RelaySettings};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_settings::TunnelSettings;

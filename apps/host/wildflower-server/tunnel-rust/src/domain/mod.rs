//! Pure tunnel domain types — no rathole coupling beyond the
//! [`TunnelStream`] it hands over — plus the [`TunnelDaemon`] that runs the
//! tunnel and the [`TunnelState`] it publishes.

mod public_origin;
mod relay_client;
mod tunnel_daemon;
mod tunnel_state;

pub use public_origin::{public_origin_url, InvalidDomain};
pub use relay_client::{DialFailure, RelayClient, RelaySettings, TunnelStream};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_state::TunnelState;

//! Pure tunnel domain types — no diesel, axum, or rathole coupling in the wire
//! contract — plus [`TunnelError`], the failure vocabulary the HTTP layer
//! renders, the [`TunnelStore`] persistence port, and the [`actions`] the HTTP
//! routes call against it.

pub(crate) mod actions;
pub(crate) mod capabilities;
mod relay_client;
mod tunnel_daemon;
mod tunnel_error;
mod tunnel_settings;
mod tunnel_store;

pub use capabilities::grantable_tunnel_scopes;
pub use relay_client::{RelayClient, RelaySettings};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_error::TunnelError;
pub use tunnel_settings::TunnelSettings;
pub use tunnel_store::{SettingsSeed, SettingsUpdate, SettingsUpdateOutcome, TunnelStore};

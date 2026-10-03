//! Pure tunnel domain types — no diesel, axum, or rathole coupling in the wire
//! contract — plus [`TunnelError`], the failure vocabulary the HTTP layer
//! renders, the [`TunnelStore`] persistence port, and the [`actions`] the HTTP
//! routes call against it. The [`request_log`] and its [`retention`] sweep sit
//! beside the settings, over their own [`RequestLogStore`] port.

pub(crate) mod actions;
pub(crate) mod capabilities;
mod public_host;
mod relay_client;
pub mod request_log;
pub(crate) mod retention;
mod tunnel_daemon;
mod tunnel_error;
mod tunnel_settings;
mod tunnel_store;

pub use capabilities::grantable_tunnel_scopes;
pub use public_host::{public_origin_url, InvalidPublicHost};
pub use relay_client::{RelayClient, RelaySettings};
pub use request_log::{CallerClass, RequestLogStore};
pub use tunnel_daemon::TunnelDaemon;
pub use tunnel_error::TunnelError;
pub use tunnel_settings::TunnelSettings;
pub use tunnel_store::{SettingsSeed, SettingsUpdate, SettingsUpdateOutcome, TunnelStore};

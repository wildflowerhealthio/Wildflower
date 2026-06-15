//! Pure tunnel domain types — no rusqlite, axum, or rathole coupling.

mod tunnel_settings;

pub use tunnel_settings::{RelaySettings, TunnelSettings};

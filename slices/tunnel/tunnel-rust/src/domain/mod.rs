//! Pure tunnel domain types — no rusqlite, axum, or rathole coupling.

pub mod tunnel_settings;

pub use tunnel_settings::{RelayConnection, TunnelSettings};

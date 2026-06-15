//! Per-table query methods, added as inherent `impl TunnelStore` blocks.
//! Mirrors `gatekeeper-rust`'s `db/` layer.

pub mod tunnel_settings;

pub use tunnel_settings::SettingsPatch;

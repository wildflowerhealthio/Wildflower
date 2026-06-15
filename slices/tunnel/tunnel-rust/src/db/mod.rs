//! `SQLite` persistence for the tunnel slice — the [`TunnelStore`] handle
//! (which wraps the shared connection and applies the tunnel migrations) plus
//! one file per table holding that table's row mappings and `TunnelStore` query
//! methods for its [`crate::domain`] type. The generic connection wrapper and
//! migration runner live in `persistence-rust`. Mirrors `gatekeeper-rust`'s
//! `db/` layer.

mod tunnel_settings;
mod tunnel_store;

pub use tunnel_settings::{SettingsUpdate, SettingsUpdateOutcome};
pub use tunnel_store::TunnelStore;

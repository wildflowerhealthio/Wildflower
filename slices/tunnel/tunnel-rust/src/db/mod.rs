//! `SQLite` persistence for the tunnel slice — the [`TunnelStore`] handle (which
//! holds the app-wide diesel r2d2 pool and applies the tunnel migrations onto
//! it) plus one file per concern: the singleton-row read/replace queries
//! (`tunnel_settings`) and the build-time seeding (`seed_tunnel_settings`). The
//! diesel `table!` schema lives in `schema`. Built on Diesel over
//! `persistence_rust::DieselPool` onto the shared database file, mirroring
//! `collector-rust`'s `RemotesStore`.

mod schema;
mod seed_tunnel_settings;
mod tunnel_settings;
mod tunnel_store;

pub use seed_tunnel_settings::SettingsSeed;
pub use tunnel_settings::{SettingsUpdate, SettingsUpdateOutcome};
pub use tunnel_store::TunnelStore;

//! `SQLite` persistence for the tunnel slice — the `SqliteTunnelStore` adapter
//! (the `SQLite` implementation of the [`TunnelStore`](crate::domain::TunnelStore)
//! port, and of the [`RequestLogStore`](crate::domain::RequestLogStore) port
//! beside it: it holds the app-wide diesel r2d2 pool and applies the tunnel
//! migrations onto it) plus one file per concern: the singleton-row read/replace
//! queries (`tunnel_settings`), the build-time seeding (`seed_tunnel_settings`),
//! and the request log (`tunnel_requests`).
//! The diesel `table!` schema lives in `schema`. Built on Diesel over
//! `persistence_rust::DieselPool` onto the shared database file, mirroring
//! `collector-rust`'s `RemotesStore`. The pure param/outcome types the port
//! speaks (`SettingsUpdate`, `SettingsUpdateOutcome`, `SettingsSeed`) live in
//! [`crate::domain`].

mod schema;
mod seed_tunnel_settings;
pub(crate) mod tunnel_requests;
mod tunnel_settings;
mod tunnel_store;

pub use tunnel_store::SqliteTunnelStore;

//! `SQLite` persistence for the relay — the `SqliteTunnelStore` adapter (the
//! `SQLite` implementation of the [`TunnelStore`](crate::domain::TunnelStore)
//! port: it opens `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db` as a diesel r2d2
//! pool, readable by the owner only, and applies the relay's migrations onto
//! it) plus the `tunnels` query bodies. The diesel `table!` schema lives in
//! `schema`. Built on Diesel over `persistence_rust::DieselPool`, mirroring
//! `collector-rust`'s `SqliteRemotesStore`. The domain type the port speaks
//! ([`StoredTunnel`](crate::domain::StoredTunnel)) lives in [`crate::domain`].

mod schema;
mod tunnel_store;
mod tunnels;

pub use tunnel_store::SqliteTunnelStore;

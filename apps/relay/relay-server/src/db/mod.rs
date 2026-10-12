//! `SQLite` persistence for the relay — the `SqliteTunnelStore` adapter (the
//! `SQLite` implementation of the [`TunnelStore`](crate::domain::TunnelStore)
//! port: it opens `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db` as a diesel r2d2
//! pool, readable by the owner only, and applies the relay's migrations onto
//! it, and of the [`ClaimCodeStore`](crate::domain::ClaimCodeStore) port over
//! the same file) plus the `tunnels` and `claim_codes` query bodies. The diesel `table!` schema lives in
//! `schema`. Built on Diesel over `wildflowerhealthio_persistence::DieselPool`, mirroring
//! `apps-rust`'s `SqliteAppsStore`. The domain type the port speaks
//! ([`StoredTunnel`](crate::domain::StoredTunnel),
//! [`StoredClaimCode`](crate::domain::StoredClaimCode)) live in
//! [`crate::domain`].

mod claim_codes;
mod schema;
mod tunnel_store;
mod tunnels;

pub use tunnel_store::SqliteTunnelStore;

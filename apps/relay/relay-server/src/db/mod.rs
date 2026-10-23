//! `SQLite` persistence for the relay — the `SqliteTunnelStore` adapter (the
//! `SQLite` implementation of the [`TunnelStore`](crate::domain::TunnelStore)
//! port: it opens `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db` as a diesel r2d2
//! pool, readable by the owner only, and applies the relay's migrations onto
//! it, and of the [`ClaimCodeStore`](crate::domain::ClaimCodeStore) port over
//! the same file, of the [`AccessCodeStore`](crate::domain::AccessCodeStore)
//! port over it too, and of the
//! [`ConnectionTotalsStore`](crate::domain::ConnectionTotalsStore) port, the
//! hourly connection totals) plus the `tunnels`, `claim_codes`,
//! `access_codes` and `connection_totals` query bodies. The diesel `table!` schema lives in
//! `schema`. Built on Diesel over `wildflowerhealthio_persistence::DieselPool`, mirroring
//! `apps-rust`'s `SqliteAppsStore`. The domain type the port speaks
//! ([`StoredTunnel`](crate::domain::StoredTunnel),
//! [`StoredClaimCode`](crate::domain::StoredClaimCode)) live in
//! [`crate::domain`].

mod access_codes;
mod claim_codes;
mod connection_totals;
mod schema;
mod tunnel_store;
mod tunnels;

pub use tunnel_store::SqliteTunnelStore;

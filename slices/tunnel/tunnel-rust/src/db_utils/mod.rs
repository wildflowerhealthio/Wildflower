//! The tunnel slice's database layer. Mirrors `gatekeeper-rust`: the generic
//! SQLite primitives come from [`persistence_rust`]; this module owns the
//! tunnel-specific [`TunnelStore`] handle and migration list. Per-table query
//! methods live as `impl TunnelStore` blocks under [`crate::db`].

pub mod migrations;
pub mod tunnel_store;

pub use tunnel_store::TunnelStore;

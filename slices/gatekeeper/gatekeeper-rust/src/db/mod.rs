//! `SQLite` persistence for the gatekeeper — the `SqliteGatekeeperStore`
//! adapter (the `SQLite` implementation of the
//! [`GatekeeperStore`](crate::domain::GatekeeperStore) port: it holds the
//! app-wide diesel r2d2 pool, `persistence_rust::DieselPool`, and applies the
//! gatekeeper migrations onto it under a per-slice namespace, mirroring
//! collector's `SqliteRemotesStore` and tunnel's `SqliteTunnelStore`) plus one
//! file per concern holding that concern's `pub(super)` query-body free
//! functions (taking a checked-out `persistence_rust::PooledDieselConnection`)
//! for its [`crate::domain`] type. [`columns`] maps the JSON/URL/enum TEXT
//! columns at the diesel bind/read boundary, and [`schema`] holds the `table!`
//! definitions (including the cross-kind `grants` VIEW).

mod authorization_codes;
mod authorization_requests;
mod clients;
pub(crate) mod columns;
mod gatekeeper_store;
mod grants;
mod refresh_tokens;
pub(crate) mod schema;
mod signing_keys;
#[cfg(test)]
mod test_support;

pub use gatekeeper_store::SqliteGatekeeperStore;

//! `SQLite` persistence for the gatekeeper — the `SqliteGatekeeperStore`
//! adapter (the `SQLite` implementation of the
//! [`GatekeeperStore`](crate::domain::GatekeeperStore) port: it holds the
//! app-wide diesel r2d2 pool, `persistence_rust::DieselPool`, and applies the
//! gatekeeper migrations onto it under a per-slice namespace, mirroring
//! collector's `SqliteRemotesStore` and tunnel's `SqliteTunnelStore`) plus one
//! file per concern holding that concern's `table!` definition, row/column
//! mappings, and `pub(super)` query-body free functions (taking a checked-out
//! `persistence_rust::PooledDieselConnection`) for its [`crate::domain`] type —
//! mirroring the apps slice's distributed layout. [`shared`] holds the two
//! column-mapping macros plus the column types more than one concern binds
//! (`JsonStrings`, `UrlText`, the `GrantType` enum mapping); every other `table!`
//! and column mapping lives in its concern file. [`grants`] is a folder split by
//! kind/context (its `authorization_code_grants` / `device_grants` tables + the
//! cross-kind `grants` VIEW).

pub(crate) mod authorization_codes;
mod authorization_requests;
pub(crate) mod clients;
mod gatekeeper_store;
pub(crate) mod grants;
pub(crate) mod refresh_tokens;
pub(crate) mod shared;
pub(crate) mod signing_keys;
#[cfg(test)]
mod test_support;

pub use gatekeeper_store::SqliteGatekeeperStore;

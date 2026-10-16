//! `SQLite` persistence for the authorization server — the `SqliteGrantStore`
//! adapter (the `SQLite` implementation of the
//! [`GrantStore`](crate::domain::GrantStore) port: it holds the
//! app-wide diesel r2d2 pool, `wildflowerhealthio_persistence::DieselPool`, and applies the
//! authorization server migrations onto it under a per-slice namespace, mirroring
//! apps' `SqliteAppsStore`) plus one
//! file per concern holding that concern's `table!` definition, row/column
//! mappings, and single-statement query-body free functions (taking a
//! `&mut SqliteConnection` — the adapter's `SqliteGrantTx` unwraps it from a
//! pooled connection or a transaction and threads it through) for its
//! [`crate::domain`] type — mirroring the apps slice's distributed layout.
//! [`shared`] holds the two
//! column-mapping macros plus the column types more than one concern binds
//! (`JsonStrings`, `UrlText`, the `GrantType` enum mapping); every other `table!`
//! and column mapping lives in its concern file. [`grants`] is a folder split by
//! kind/context (its `authorization_code_grants` / `device_grants` tables + the
//! cross-kind `grants` VIEW).

pub(crate) mod authorization_codes;
mod authorization_requests;
pub(crate) mod browser_sessions;
pub(crate) mod clients;
mod grant_store;
pub(crate) mod grants;
pub(crate) mod launch_contexts;
pub(crate) mod refresh_tokens;
pub(crate) mod shared;
pub(crate) mod signing_keys;
#[cfg(test)]
mod test_support;

pub use grant_store::SqliteGrantStore;

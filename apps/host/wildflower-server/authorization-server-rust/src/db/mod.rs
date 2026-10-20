//! `SQLite` persistence for the authorization server: the `SqliteGrantStore`
//! adapter of the [`GrantStore`](crate::domain::GrantStore) port, over the
//! app-wide diesel r2d2 pool (`wildflowerhealthio_persistence::DieselPool`)
//! with the authorization server's migrations applied under a per-slice
//! namespace, mirroring apps' `SqliteAppsStore`.
//!
//! `grant_store` holds the pool, the migrations and the two scopes. Each
//! concern's file holds its `table!`, its row and column mappings, and its
//! port trait implemented on `SqliteGrantTx` (the scope's handle on one
//! checked-out connection). `shared` holds the two column-mapping macros
//! and the column types more than one concern binds (`JsonStrings`,
//! `UrlText`, the `FlowType` mapping). `grants` is a folder split by kind
//! (its `authorization_code_grants` / `device_grants` tables, and the
//! cross-kind `grants` view).

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

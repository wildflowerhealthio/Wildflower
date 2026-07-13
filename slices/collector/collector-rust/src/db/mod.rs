//! `SQLite` persistence for the collector slice — the `SqliteRemotesStore`
//! adapter (the `SQLite` implementation of the
//! [`RemotesStore`](crate::domain::RemotesStore) port: it holds the app-wide
//! diesel r2d2 pool and applies the collector migrations onto it) plus the
//! per-concern `collector_remotes` query bodies (`remotes`). The diesel
//! `table!` schema lives in `schema`. Built on Diesel over
//! `persistence_rust::DieselPool` onto the shared database file, and loads /
//! writes [`crate::domain::Remote`] directly (the domain type carries the diesel
//! derives); the shared
//! [`JsonText`](shared_structures_rust::json_text::JsonText) newtype maps its
//! `config` field to the JSON TEXT column. Mirrors `tunnel-rust`'s
//! `SqliteTunnelStore`.

mod remotes;
mod remotes_store;
pub(crate) mod schema;

pub use remotes_store::SqliteRemotesStore;

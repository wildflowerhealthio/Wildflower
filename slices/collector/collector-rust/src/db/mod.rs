//! `SQLite` persistence for the collector slice — the [`RemotesStore`] over
//! the `collector_remotes` table, built on Diesel over the app-wide r2d2
//! connection pool (`persistence_rust::DieselPool`) onto the shared database
//! file. The store embeds and applies the collector migrations on construction
//! and loads / writes [`crate::domain::Remote`] directly (the domain type
//! carries the diesel derives); the shared
//! [`JsonText`](shared_structures_rust::json_text::JsonText) newtype maps its
//! `config` field to the JSON TEXT column.

mod remotes_store;
pub(crate) mod schema;

pub use remotes_store::RemotesStore;

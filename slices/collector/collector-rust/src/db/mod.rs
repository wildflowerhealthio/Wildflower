//! `SQLite` persistence for the collector slice — the [`RemotesStore`] over
//! the `collector_remotes` table, built on Diesel over the crate's own
//! `SqliteConnection` (opened onto the host's shared database file). The store
//! embeds and applies the collector migrations on construction;
//! [`crate::domain::Remote`] is mapped to/from an internal row struct that
//! carries `config` as JSON TEXT.

mod remotes_store;
mod schema;

pub use remotes_store::RemotesStore;

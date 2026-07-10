//! `SQLite` persistence for the collector slice — the [`RemotesStore`] over
//! the `collector_remotes` table, built on the shared `persistence-rust`
//! primitives (`sql_row!` / `build_insert_sql`, namespaced migrations on the
//! host's shared connection). [`crate::domain::Remote`] doubles as the row
//! mapping.

mod remotes_store;

pub use remotes_store::RemotesStore;

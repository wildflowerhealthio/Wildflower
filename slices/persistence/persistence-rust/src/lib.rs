//! `persistence-rust` — common `SQLite` persistence utilities shared across Rust
//! slices.
//!
//! These are the generic, slice-agnostic pieces lifted out of
//! `gatekeeper-rust`'s `db_utils`. The Tauri app opens one shared [`Connection`]
//! and passes it to each slice; each slice runs its own append-only migrations
//! under its own `namespace` (see [`run_migrations`]) on that shared database.
//!
//!  - [`Connection`] / [`DbResult`] — a clonable, mutex-synchronized rusqlite
//!    connection handle, opened once and shared.
//!  - [`DieselPool`] / [`open_pool`] — the diesel counterpart: an app-wide r2d2
//!    pool onto the same database file, shared across diesel-backed slices, with
//!    per-connection pragmas mirroring [`Connection`].
//!  - [`run_migrations`] — a per-namespace `schema_migrations` runner so slices
//!    coexist in one database.
//!  - [`JsonColumn`] / [`UriColumn`] — column newtypes with `FromSql`/`ToSql`.
//!  - [`build_insert_sql`] + the [`sql_row!`] macro — generate a table's
//!    `TryFrom<&Row>`, named-param array, and column list from one field list.

// Private modules: their public items are surfaced through the curated `pub use`
// below, so there's exactly one path to each (`persistence_rust::Connection`,
// not also `persistence_rust::connection::Connection`).
mod connection;
mod diesel_pool;
mod json_column;
mod migrations;
// `sql_row!` is `#[macro_export]`ed at the crate root (see `row_mapping`);
// consumers reach it as `persistence_rust::sql_row`.
mod row_mapping;
mod sql_builder;
mod uri_column;

pub use connection::{Connection, DbResult};
pub use diesel_pool::{open_in_memory_pool, open_pool, DieselPool};
pub use json_column::JsonColumn;
pub use migrations::run_migrations;
pub use sql_builder::build_insert_sql;
pub use uri_column::UriColumn;

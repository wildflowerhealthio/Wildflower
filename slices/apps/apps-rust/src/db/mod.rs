//! `SQLite` persistence for the apps slice — the [`AppsStore`] handle
//! plus the per-row `FromSql`/`ToSql` glue for `AppKind`. There is no
//! separate "row" type: `domain::AppEntry`'s field names match the SQL
//! columns, so the `persistence_rust::sql_row!` macro derives the
//! row-mapping boilerplate directly off it.

mod apps_store;

pub use apps_store::AppsStore;

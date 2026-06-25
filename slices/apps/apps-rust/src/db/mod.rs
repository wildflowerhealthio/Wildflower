//! `SQLite` persistence for the apps slice. Two tables, **one store**:
//!
//!  - [`AppsStore`] serves the whole slice. It owns the shared migration list
//!    (so constructing it migrates both tables) and exposes the externals CRUD
//!    (`apps`, read + write, editable through the admin API) plus the read-only
//!    internals accessors (`internal_apps`, seeded by migration —
//!    `list_internal_apps` / `find_internal_app`).
//!
//! The internals' row mapping + queries live in the [`internal_apps`] module
//! only because the `sql_row!`-generated `ALL_COLS` is module-scoped; the
//! `AppsStore` methods delegate to them. There is no separate "row" type for
//! either table: [`crate::domain::AppEntry`] (externals) and
//! [`crate::domain::InternalApp`] (internals) double as the row mappings via
//! `persistence_rust::sql_row!`.

mod apps_store;
mod internal_apps;

pub use apps_store::AppsStore;

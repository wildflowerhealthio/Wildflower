//! `SQLite` persistence for the apps slice. Two tables, two stores:
//!
//!  - [`AppsStore`] — the externals catalogue (`apps`). Read + write,
//!    editable through the admin API. Also owns the shared migration list,
//!    so constructing it migrates both tables.
//!  - [`InternalAppsStore`] — the static internals catalogue
//!    (`internal_apps`). Read-only at runtime; seeded by migration.
//!
//! Both stores share the [`persistence_rust::Connection`] handle the host
//! opens once. There is no separate "row" type for either:
//! [`crate::domain::AppEntry`] (externals) and [`crate::domain::InternalApp`]
//! (internals) double as the row mappings via `persistence_rust::sql_row!`.

mod apps_store;
mod internal_apps_store;

pub use apps_store::AppsStore;
pub use internal_apps_store::InternalAppsStore;

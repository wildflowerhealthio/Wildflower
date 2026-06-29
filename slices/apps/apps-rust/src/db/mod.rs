//! `SQLite` persistence for the apps slice. A parent registry plus per-kind
//! child tables, **one store**:
//!
//!  - [`AppsStore`] serves the whole slice. It owns the shared migration list
//!    (so constructing it migrates every table) and exposes:
//!     - the parent `apps` registry reads + the atomic reorder/enable write
//!       (`list_app_entries`, `find_app`, `replace_home_screen`) — see
//!       [`apps_store`];
//!     - the cloud-app CRUD (`find_cloud_app`, `insert_cloud_app`,
//!       `replace_cloud_app`, `delete_app`) over `apps` + `cloud_apps` — see
//!       [`cloud_apps`];
//!     - the read-only self-hosted accessors (`list_self_hosted_apps`,
//!       `find_self_hosted_app`) over `self_hosted_apps` — see
//!       [`self_hosted_apps`].
//!
//! The cloud + self-hosted operations live in their own modules — further
//! `impl AppsStore` blocks. **This is the one reason they are split:** each
//! `sql_row!`-generated `ALL_COLS` is module-scoped and would collide if two of
//! them shared a file. There is no separate "row" type: [`crate::domain::App`]
//! (parent), [`crate::domain::AppEntry`] (cloud) and
//! [`crate::domain::SelfHostedApp`] (self-hosted) double as the row mappings via
//! `persistence_rust::sql_row!` (or, for the JOINed shapes, a hand-written
//! mapping).
//!
//! For the provenance taxonomy these tables encode, see
//! `docs/Apps/Explanation.md`.

mod apps_store;
mod cloud_apps;
mod self_hosted_apps;

pub use apps_store::AppsStore;

//! `SQLite` persistence for the apps slice — the [`SqliteAppsStore`] adapter (the
//! `SQLite` implementation of the [`AppsStore`](crate::domain::AppsStore) port: it
//! holds the app-wide diesel r2d2 pool and applies the apps migrations onto it)
//! plus the per-concern query bodies it delegates to. Table-per-struct: standalone
//! `cloud_apps` and `self_hosted_apps`, plus a `home_screen` table for the
//! cross-kind ordering + enabled flag; system apps have no table.
//!
//! [`SqliteAppsStore::new`] applies the embedded migrations once on a pooled
//! connection via [`persistence_rust::run_diesel_migrations`] under this slice's
//! namespace (`"apps"`), so its `0001` and another diesel slice's `0001` never
//! collide in diesel's stock (un-namespaced) `__diesel_schema_migrations` — the
//! two diesel slices coexist in the shared database. The modules split by concern:
//!
//!  - [`apps_store`] — the adapter (pool handle + migrations + the port `impl`);
//!  - [`schema`] — the diesel `table!` definitions;
//!  - [`columns`] — the diesel column newtypes for `AppUrl` (TEXT) and `port`
//!    (INTEGER → `u16`);
//!  - [`reads`] — the cross-kind `apps_view` decode ([`App`](crate::domain::App))
//!    and every read over it (`list_apps_on`, `find_app_on`,
//!    `list_self_hosted_apps_on`);
//!  - [`writes`] — the per-kind mutators (each a single-kind write to a concrete
//!    table plus its `home_screen` row), returning the hydrated app re-read.
//!
//! For the provenance taxonomy these tables encode, see
//! `docs/Apps/Explanation.md`.

mod apps_store;
pub(crate) mod columns;
mod reads;
pub(crate) mod schema;
mod writes;

pub use apps_store::SqliteAppsStore;

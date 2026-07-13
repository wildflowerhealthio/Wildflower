//! `SQLite` persistence for the apps slice — the [`SqliteAppsStore`] adapter (the
//! `SQLite` implementation of the [`AppsStore`](crate::domain::AppsStore) port: it
//! holds the app-wide diesel r2d2 pool and applies the apps migrations onto it)
//! plus the per-concern query bodies it delegates to. Class-table-inheritance: one
//! authoritative `app_registry` parent (the global id space + shared facts +
//! placement) with three symmetric child payload tables (`system_apps` /
//! `cloud_apps` / `self_hosted_apps`), real FKs child → parent.
//!
//! [`SqliteAppsStore::new`] applies the embedded migrations once on a pooled
//! connection via [`persistence_rust::run_diesel_migrations`] under this slice's
//! namespace (`"apps"`), so its `0001` and another diesel slice's `0001` never
//! collide in diesel's stock (un-namespaced) `__diesel_schema_migrations` — the
//! two diesel slices coexist in the shared database. The modules split by concern:
//!
//!  - [`apps_store`] — the adapter (pool handle + migrations + the port `impl`);
//!  - [`schema`] — the diesel `table!` definitions;
//!  - [`columns`] — the diesel column newtypes for `AppKind` (TEXT), `AppUrl`
//!    (TEXT) and `port` (INTEGER → `u16`);
//!  - [`payloads`] — the per-kind child payload row structs;
//!  - [`reads`] — the uniform registry read ([`AppRegistration`](crate::domain::AppRegistration)),
//!    the per-kind detail read composing a whole [`App`](crate::domain::App)
//!    (`find_app_on`), and `list_self_hosted_apps_on`;
//!  - [`writes`] — the mutators (registration + payload in one transaction),
//!    returning the hydrated app re-read.
//!
//! For the app taxonomy these tables encode, see `docs/Apps/Explanation.md`.

mod apps_store;
pub(crate) mod columns;
mod payloads;
mod reads;
pub(crate) mod schema;
mod writes;

pub use apps_store::SqliteAppsStore;

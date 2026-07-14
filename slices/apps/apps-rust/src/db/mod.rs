//! `SQLite` persistence for the apps slice — the [`SqliteAppsStore`] adapter (the
//! `SQLite` implementation of the [`AppsStore`](crate::domain::AppsStore) port: it
//! holds the app-wide diesel r2d2 pool and applies the apps migrations onto it)
//! plus the query bodies it delegates to. One authoritative `app_registrations` table
//! (the global id space + shared facts + placement) with three per-kind configuration
//! tables (`system_app_configurations` / `cloud_app_configurations` /
//! `self_hosted_app_configurations`), real FKs configuration → registration.
//!
//! [`SqliteAppsStore::new`] applies the embedded migrations once on a pooled
//! connection via [`persistence_rust::run_diesel_migrations`] under this slice's
//! namespace (`"apps"`), so its `0001` and another diesel slice's `0001` never
//! collide in diesel's stock (un-namespaced) `__diesel_schema_migrations` — the
//! two diesel slices coexist in the shared database.
//!
//! Beyond the adapter, the query bodies split **by kind / context** (mirroring
//! `domain::actions`), so each kind's `table!`, row struct, column mappings, and
//! queries live together:
//!
//!  - [`apps_store`] — the adapter (pool handle + migrations + the port `impl`);
//!  - [`app_registration`] — the shared `app_registrations` `table!`, its
//!    `AppKindColumn`, and the registration-wide queries (uniform list, id / position
//!    allocators, the placement rewrite);
//!  - [`cloud_apps`] / [`self_hosted_apps`] / [`system_apps`] — each kind's
//!    configuration `table!` + row struct + its mutators (system is read-only);
//!  - [`all_kinds_apps`] — the reads/deletes that resolve any kind by id
//!    (`find_app_on`, `delete_app`), importing the per-kind tables;
//!  - [`shared`] — the one column mapping (`AppUrlColumn`) two kinds share.
//!
//! For the app taxonomy these tables encode, see `docs/Apps/Explanation.md`.

mod all_kinds_apps;
pub(crate) mod app_registration;
mod apps_store;
mod cloud_apps;
mod self_hosted_apps;
mod shared;
mod system_apps;

#[cfg(test)]
mod test_support;

pub use apps_store::SqliteAppsStore;

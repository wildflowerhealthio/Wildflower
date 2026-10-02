//! `SQLite` persistence for the apps slice — the [`SqliteAppsStore`] adapter (the
//! `SQLite` implementation of the [`AppsStore`](crate::domain::AppsStore) port: it
//! holds the app-wide diesel r2d2 pool and applies the apps migrations onto it)
//! plus the query bodies it delegates to, over the one `app_registrations` table.
//!
//! [`SqliteAppsStore::new`] applies the embedded migrations once on a pooled
//! connection via [`persistence_rust::run_diesel_migrations`] under this slice's
//! namespace (`"apps"`), so its `0001` and another diesel slice's `0001` never
//! collide in diesel's stock (un-namespaced) `__diesel_schema_migrations` — the
//! two diesel slices coexist in the shared database.
//!
//!  - [`apps_store`] — the adapter (pool handle + migrations + the port `impl`);
//!  - [`app_registration`] — the `app_registrations` `table!`, its `AppUrlColumn`,
//!    and the query bodies (catalogue + by-id reads, insert / replace / delete, the
//!    placement rewrite);
//!  - [`shared`] — the `text_column!` macro behind `AppUrlColumn`.
//!
//! For the app model the table encodes, see `docs/Apps/Explanation.md`.

pub(crate) mod app_registration;
mod apps_store;
mod shared;

#[cfg(test)]
mod test_support;

pub use apps_store::SqliteAppsStore;

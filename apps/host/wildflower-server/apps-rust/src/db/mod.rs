//! `SQLite` persistence for the apps slice — the [`SqliteAppsStore`] adapter (the
//! `SQLite` implementation of the [`AppsStore`](crate::domain::AppsStore) port: it
//! holds the app-wide diesel r2d2 pool, applies the apps migrations onto it, and
//! runs the queries over the one `app_registrations` table).
//!
//! [`SqliteAppsStore::new`] applies the embedded migrations once on a pooled
//! connection via [`persistence_rust::run_diesel_migrations`] under this slice's
//! namespace (`"apps"`), so its `0001` and another diesel slice's `0001` never
//! collide in diesel's stock (un-namespaced) `__diesel_schema_migrations` — the
//! two diesel slices coexist in the shared database.
//!
//!  - [`apps_store`] — the adapter (pool handle + migrations + the port `impl`),
//!    the `app_registrations` `table!`, and its `AppUrlColumn`.
//!
//! For the app model the table encodes, see `docs/Apps/Explanation.md`.

pub(crate) mod apps_store;

#[cfg(test)]
pub(crate) mod test_support;

pub use apps_store::SqliteAppsStore;

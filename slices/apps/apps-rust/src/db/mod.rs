//! `SQLite` persistence for the apps slice — the [`AppsStore`] handle (which
//! wraps the shared connection and applies the apps migrations) plus one
//! sibling module per concern: [`app_row`] holds the row mapping and per-row
//! queries; [`mutations`] holds the writer methods used by the admin
//! handlers. Mirrors `tunnel-rust` / `gatekeeper-rust`'s `db/` layer.

mod app_row;
mod apps_store;
mod mutations;

pub use app_row::AppRow;
pub use apps_store::AppsStore;
pub use mutations::{CreateCustomApp, UpdateApp, UpdateOutcome};

//! Pure apps domain types — no rusqlite or axum coupling.

mod app_entry;
mod app_list_entry;
mod app_url;
mod internal_app;

pub use app_entry::AppEntry;
pub use app_list_entry::AppListEntry;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use internal_app::InternalApp;

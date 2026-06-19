//! Pure apps domain types — no rusqlite or axum coupling.

mod app_entry;
mod app_url;

pub use app_entry::AppEntry;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};

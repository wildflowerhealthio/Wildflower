//! Pure apps domain types — no rusqlite or axum coupling.

mod app_entry;
mod app_url;

pub use app_entry::{AppEntry, AppKind, AppKindParseError};
pub use app_url::{validate_app_url, AppUrlError};

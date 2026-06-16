//! Pure apps domain types — no rusqlite or axum coupling.

mod app_entry;
mod bundled_registry;
mod custom_url;

pub use app_entry::{AppEntry, AppKind};
pub use bundled_registry::{find_bundled, BundledApp, BundledKind, BUNDLED_APPS, FHIR_SHARING_ID};
pub use custom_url::{validate_custom_url, CustomUrlError};

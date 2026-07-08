//! Pure apps domain types — no rusqlite or axum coupling.

mod app;
mod app_list_entry;
mod app_url;
mod cloud_app;
mod provenance;
mod self_hosted_app;
pub mod system_app;

pub use app::{App, AppKind};
pub use app_list_entry::AppListEntry;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use cloud_app::{CloudApp, CloudAppRow};
pub use provenance::{Provenance, ProvenanceParseError};
pub use self_hosted_app::{SelfHostedApp, SelfHostedAppRow};
pub use system_app::{SystemApp, SYSTEM_APPS};

//! Pure apps domain types — no rusqlite or axum coupling.

mod app;
mod app_list_entry;
mod app_url;
mod cloud_app;
mod provenance;
mod self_hosted_app;
mod specs;
pub mod system_app;

pub use app::{App, AppKind};
pub use app_list_entry::AppListEntry;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use cloud_app::CloudApp;
pub use provenance::{Provenance, ProvenanceParseError};
pub use self_hosted_app::SelfHostedApp;
pub use specs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};
pub use system_app::{SystemApp, SYSTEM_APPS};

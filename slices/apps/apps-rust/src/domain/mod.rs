//! Apps domain types. The concrete records ([`CloudApp`] / [`SelfHostedApp`]) are
//! the diesel-mapped row types owning all their fields; [`SystemApp`] is the
//! compiled-in source; [`App`] is the thin enum at the list/wire seam pairing a
//! record with its `home_screen` placement. [`AppError`] is the semantic failure
//! vocabulary the HTTP layer renders. The [`AppsStore`] persistence port and the
//! [`actions`] the HTTP routes call against it complete the ports-and-adapters
//! seam (the `SQLite` adapter lives in [`crate::db`]), mirroring collector.

pub(crate) mod actions;
mod app;
mod app_error;
mod app_list_entry;
mod app_record;
mod app_url;
mod apps_store;
mod cloud_app;
mod provenance;
mod self_hosted_app;
pub mod system_app;
mod write_inputs;

pub use app::App;
pub use app_error::AppError;
pub use app_list_entry::AppListEntry;
pub use app_record::AppRecord;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use apps_store::AppsStore;
pub use cloud_app::CloudApp;
pub use provenance::{Provenance, ProvenanceParseError};
pub use self_hosted_app::SelfHostedApp;
pub use system_app::{SystemApp, SYSTEM_APPS};
pub use write_inputs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};

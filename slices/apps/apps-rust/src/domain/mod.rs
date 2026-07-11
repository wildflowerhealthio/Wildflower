//! Apps domain types. The concrete records ([`CloudApp`] / [`SelfHostedApp`]) are
//! the diesel-mapped row types owning all their fields; [`SystemApp`] is the
//! compiled-in source; [`App`] is the thin enum at the list/wire seam pairing a
//! record with its `home_screen` placement. [`AppError`] is the semantic failure
//! vocabulary the HTTP layer renders.

mod app;
mod app_error;
mod app_list_entry;
mod app_record;
mod app_url;
mod cloud_app;
mod provenance;
mod self_hosted_app;
pub mod system_app;

pub use app::App;
pub use app_error::AppError;
pub use app_list_entry::AppListEntry;
pub use app_record::AppRecord;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use cloud_app::CloudApp;
pub use provenance::{Provenance, ProvenanceParseError};
pub use self_hosted_app::SelfHostedApp;
pub use system_app::{SystemApp, SYSTEM_APPS};

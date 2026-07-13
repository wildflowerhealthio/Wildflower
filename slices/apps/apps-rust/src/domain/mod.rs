//! Apps domain types. [`AppRegistration`] is the authoritative `app_registry` row
//! (the shared catalogue facts + placement) — both the diesel row and the uniform
//! `GET /apps` wire item. The per-kind detail types ([`CloudApp`] /
//! [`SelfHostedApp`] / [`SystemApp`]) each pair a registration with their child
//! payload and project the per-kind editor wire shapes ([`CloudAppDetail`] etc.).
//! [`App`] is the thin enum at the cross-kind seams (launch dispatch, delete
//! removability). [`AppKind`] is the CTI discriminator. [`AppError`] is the
//! semantic failure vocabulary the HTTP layer renders. The [`AppsStore`]
//! persistence port and the [`actions`] the HTTP routes call against it complete
//! the ports-and-adapters seam (the `SQLite` adapter lives in [`crate::db`]),
//! mirroring collector.

pub(crate) mod actions;
mod app;
mod app_error;
mod app_record;
mod app_registration;
mod app_url;
mod apps_store;
mod cloud_app;
mod kind;
mod self_hosted_app;
mod system_app;
mod write_inputs;

pub use app::App;
pub use app_error::AppError;
pub use app_record::AppRecord;
pub use app_registration::AppRegistration;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use apps_store::AppsStore;
pub use cloud_app::{CloudApp, CloudAppDetail};
pub use kind::{AppKind, AppKindParseError};
pub use self_hosted_app::{SelfHostedApp, SelfHostedAppDetail};
pub use system_app::{SystemApp, SystemAppDetail};
pub use write_inputs::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};

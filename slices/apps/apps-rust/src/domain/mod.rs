//! Apps domain types. [`AppRegistration`] is the authoritative `app_registrations`
//! row (the shared catalogue facts + placement) — both the diesel row and the
//! uniform `GET /apps` wire item. The per-kind configuration types
//! ([`CloudAppConfiguration`] / [`SelfHostedAppConfiguration`] /
//! [`SystemAppConfiguration`]) each hold their table's payload; a whole app is a
//! `(AppRegistration, …Configuration)` pair. [`App`] is the thin enum at the
//! cross-kind seams (launch dispatch, delete removability) whose variants are those
//! pairs. [`AppBehaviour`] is the one per-kind verdict (removability). [`AppKind`]
//! is the discriminator. [`AppsError`] is the semantic failure vocabulary the HTTP
//! layer renders. The [`AppsStore`] persistence port and the [`actions`] the HTTP
//! routes call against it complete the ports-and-adapters seam (the `SQLite`
//! adapter lives in [`crate::db`]), mirroring collector.

pub(crate) mod actions;
mod app;
mod app_behaviour;
mod app_registration;
mod app_url;
mod apps_error;
mod apps_store;
mod cloud_app_configuration;
mod kind;
mod self_hosted_app_configuration;
mod system_app_configuration;

pub use app::App;
pub use app_behaviour::AppBehaviour;
pub use app_registration::AppRegistration;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use apps_error::AppsError;
pub use apps_store::AppsStore;
pub use cloud_app_configuration::{
    CloudAppConfiguration, CloudContent, CloudInsertError, NewCloudApp,
};
pub use kind::{AppKind, AppKindParseError};
pub use self_hosted_app_configuration::{
    NewSelfHostedUpload, SelfHostedAppConfiguration, UploadInsertError,
};
pub use system_app_configuration::SystemAppConfiguration;

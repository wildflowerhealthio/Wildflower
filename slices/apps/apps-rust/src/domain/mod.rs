//! Apps domain types. [`AppRegistration`] is the authoritative `app_registrations`
//! row (the shared catalogue facts + placement) — both the diesel row and the
//! uniform `GET /apps` wire item. The per-kind configuration types
//! ([`CloudAppConfiguration`] / [`SelfHostedAppConfiguration`] /
//! [`SystemAppConfiguration`]) each hold their table's payload; a whole app is a
//! `(AppRegistration, …Configuration)` pair, and [`AppConfiguration`] is the
//! configuration-of-unknown-kind a `find_app` read returns beside its registration.
//! There is no "combined app" type: the two halves are composed directly as a
//! `(registration, configuration)` pair at the HTTP seams that need a whole app of
//! runtime-resolved kind (the launch dispatch, delete). [`CommonAppConfig`] is the
//! common per-config
//! interface (its [`AppKind`] + removability). [`AppsError`] is the semantic failure
//! vocabulary the HTTP layer renders. The [`AppsStore`] persistence port and the
//! [`actions`] the HTTP routes call against it complete the ports-and-adapters seam
//! (the `SQLite` adapter lives in [`crate::db`]), mirroring collector.

pub(crate) mod actions;
mod app_configuration;
mod app_registration;
mod app_url;
mod apps_error;
mod apps_store;
mod cloud_app_configuration;
mod common_app_config;
mod kind;
mod self_hosted_app_configuration;
mod system_app_configuration;

pub use app_configuration::AppConfiguration;
pub(crate) use app_registration::is_exact_registry_permutation;
pub use app_registration::AppRegistration;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use apps_error::AppsError;
pub use apps_store::AppsStore;
pub use cloud_app_configuration::{CloudAppConfiguration, CloudInsertError};
pub use common_app_config::CommonAppConfig;
pub use kind::{AppKind, AppKindParseError};
pub(crate) use self_hosted_app_configuration::{choose_self_hosted_slug, lowest_free_port};
pub use self_hosted_app_configuration::{
    NewSelfHostedUpload, SelfHostedAppConfiguration, UploadInsertError,
};
pub use system_app_configuration::SystemAppConfiguration;

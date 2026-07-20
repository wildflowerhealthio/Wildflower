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
//! vocabulary the HTTP layer renders. The [`AppsStore`] persistence port (the `SQLite`
//! adapter lives in [`crate::db`]) and the scope-gated [`capabilities`] the HTTP
//! handlers acquire complete the ports-and-adapters seam; each capability owns its
//! operation's store logic (synthesizing the `(registration, configuration)` a
//! create/replace persists, gating on kind + seeded, mapping the store's primitive
//! signals onto [`AppsError`]) — including the cross-kind `(registration,
//! configuration)` read (a private `get_app` helper in [`capabilities`], with the
//! launch route inlining the same `find_app` + `NotFound` shape) — while the
//! [`actions`] module holds the write-side validators they share. Mirrors collector.

pub(crate) mod actions;
mod app_configuration;
mod app_registration;
mod app_url;
mod apps_error;
mod apps_store;
pub(crate) mod capabilities;
mod cloud_app_configuration;
mod common_app_config;
mod kind;
mod self_hosted_app_configuration;
mod self_hosted_installer;
mod system_app_configuration;

pub use app_configuration::AppConfiguration;
pub(crate) use app_registration::is_exact_registry_permutation;
pub use app_registration::AppRegistration;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use apps_error::AppsError;
pub use apps_store::AppsStore;
// The apps admin surface's grantable scope vocabulary (mirrors gatekeeper's
// `grantable_admin_scopes`) — re-exported so a consent surface / registry test can
// name it; `Apps.{r,c,u,d}` today.
pub use capabilities::grantable_apps_scopes;
pub use cloud_app_configuration::{CloudAppConfiguration, CloudInsertError};
pub use common_app_config::CommonAppConfig;
pub use kind::{AppKind, AppKindParseError};
pub(crate) use self_hosted_app_configuration::{lowest_free_port, MIN_UPLOAD_PORT};
pub use self_hosted_app_configuration::{
    SelfHostedAppConfiguration, SelfHostedAppConfigurationPayload,
};
pub(crate) use self_hosted_installer::{SelfHostedInstaller, StagedBundle};
pub use system_app_configuration::SystemAppConfiguration;

//! The per-kind configuration rows — the diesel-mapped `system_app_configurations`
//! / `cloud_app_configurations` / `self_hosted_app_configurations` records, each
//! holding exactly its kind's payload columns (`id` = the FK into
//! `app_registrations`). A whole app is an
//! [`AppRegistration`](crate::domain::AppRegistration) paired with the one
//! configuration its `kind` names: [`super::reads::find_app_on`] reads the
//! registration, then the matching configuration row here, and composes the domain
//! configuration type ([`CloudAppConfiguration`](crate::domain::CloudAppConfiguration)
//! etc.). A registration whose configuration row is missing is the invariant
//! breach the read surfaces as a typed error.

use diesel::prelude::{Insertable, Queryable, Selectable};

use super::columns::{AppUrlColumn, PortColumn};
use super::schema::{
    cloud_app_configurations, self_hosted_app_configurations, system_app_configurations,
};
use crate::domain::{
    AppUrl, CloudAppConfiguration, SelfHostedAppConfiguration, SystemAppConfiguration,
};

/// The `system_app_configurations` payload — a compiled-shell route's
/// `{origin}`-relative launch template.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = system_app_configurations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct SystemConfigurationRow {
    pub(super) id: String,
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub(super) url: AppUrl,
}

/// The `cloud_app_configurations` payload — the remote launch URL template.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = cloud_app_configurations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct CloudConfigurationRow {
    pub(super) id: String,
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub(super) url: AppUrl,
}

/// The `self_hosted_app_configurations` payload — the loopback binding and
/// launch-render inputs.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = self_hosted_app_configurations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct SelfHostedConfigurationRow {
    pub(super) id: String,
    #[diesel(serialize_as = PortColumn, deserialize_as = PortColumn)]
    pub(super) port: u16,
    pub(super) content_folder: String,
    pub(super) subdomain: String,
    pub(super) seeded: bool,
    pub(super) launch_path: Option<String>,
}

// Each row → its domain configuration: drop the `id` (that's the paired
// registration's key, not part of the payload) and hand back the payload columns.
// The reads compose these onto the `AppConfiguration` union beside the registration.

impl From<SystemConfigurationRow> for SystemAppConfiguration {
    fn from(row: SystemConfigurationRow) -> Self {
        SystemAppConfiguration { url: row.url }
    }
}

impl From<CloudConfigurationRow> for CloudAppConfiguration {
    fn from(row: CloudConfigurationRow) -> Self {
        CloudAppConfiguration { url: row.url }
    }
}

impl From<SelfHostedConfigurationRow> for SelfHostedAppConfiguration {
    fn from(row: SelfHostedConfigurationRow) -> Self {
        SelfHostedAppConfiguration {
            port: row.port,
            content_folder: row.content_folder,
            subdomain: row.subdomain,
            seeded: row.seeded,
            launch_path: row.launch_path,
        }
    }
}

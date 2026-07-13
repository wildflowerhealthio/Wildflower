//! The per-kind child payload rows — the diesel-mapped `system_apps` /
//! `cloud_apps` / `self_hosted_apps` records, each holding exactly its kind's
//! payload columns (`id` = the FK into `app_registry`). A whole app is a
//! [`AppRegistration`](crate::domain::AppRegistration) plus the one payload its
//! `kind` names: [`super::reads::find_app_on`] reads the registration, then the
//! matching payload here, and composes the domain detail type ([`CloudApp`] etc.).
//! A registration whose payload row is missing is the CTI invariant breach the
//! read surfaces as a typed error.

use diesel::prelude::{Insertable, Queryable, Selectable};

use super::columns::{AppUrlColumn, PortColumn};
use super::schema::{cloud_apps, self_hosted_apps, system_apps};
use crate::domain::AppUrl;

/// The `system_apps` payload — a compiled-shell route's `{origin}`-relative launch
/// template.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = system_apps)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct SystemPayload {
    pub(super) id: String,
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub(super) url: AppUrl,
}

/// The `cloud_apps` payload — the remote launch URL template.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = cloud_apps)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct CloudPayload {
    pub(super) id: String,
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub(super) url: AppUrl,
}

/// The `self_hosted_apps` payload — the loopback binding and launch-render inputs.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = self_hosted_apps)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct SelfHostedPayload {
    pub(super) id: String,
    #[diesel(serialize_as = PortColumn, deserialize_as = PortColumn)]
    pub(super) port: u16,
    pub(super) content_folder: String,
    pub(super) subdomain: String,
    pub(super) seeded: bool,
    pub(super) launch_path: Option<String>,
}

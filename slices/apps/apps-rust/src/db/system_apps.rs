//! The `system_app_configurations` table and its row struct. System apps are
//! read-only (seeded compiled-shell routes), so this file carries no mutators — just
//! the `table!` definition and the [`SystemConfigurationRow`] the cross-kind
//! [`find_app_on`](super::all_kinds_apps::find_app_on) reads and composes onto the
//! [`SystemAppConfiguration`](crate::domain::SystemAppConfiguration) domain payload.

use diesel::prelude::{Insertable, Queryable, Selectable};

use super::app_registration::app_registrations;
use super::shared::AppUrlColumn;
use crate::domain::{AppUrl, SystemAppConfiguration};

diesel::table! {
    system_app_configurations (id) {
        id -> Text,
        url -> Text,
    }
}

// This configuration's PK is a FK into `app_registrations`, so a system payload row
// can be joined to its registration; the pair is allowed in one query so this file's
// reads can reference both tables.
diesel::joinable!(system_app_configurations -> app_registrations (id));
diesel::allow_tables_to_appear_in_same_query!(app_registrations, system_app_configurations);

/// The `system_app_configurations` payload — a compiled-shell route's
/// `{origin}`-relative launch template. `id` is the FK into `app_registrations`;
/// [`From`] drops it and hands back the payload.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = system_app_configurations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct SystemConfigurationRow {
    pub(super) id: String,
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub(super) url: AppUrl,
}

impl From<SystemConfigurationRow> for SystemAppConfiguration {
    fn from(row: SystemConfigurationRow) -> Self {
        SystemAppConfiguration { url: row.url }
    }
}

//! Cloud apps in the store: the `cloud_app_configurations` table, its row struct, and
//! the cloud mutators. A cloud app is an
//! [`AppRegistration`](crate::domain::AppRegistration) paired with a
//! [`CloudAppConfiguration`](crate::domain::CloudAppConfiguration) (a remote launch
//! URL template). Insert writes the registration + payload in one transaction and
//! reports a colliding id as [`CloudInsertError::IdTaken`]; a content replace touches
//! only the editable subset. Both hand back the hydrated pair via `RETURNING` on the
//! writing statements — no separate read-back — which also re-decodes the stored
//! `url`, so a value that no longer round-trips surfaces as a typed error.

use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;

use super::app_registration::{app_registrations, id_taken, next_position};
use super::shared::AppUrlColumn;
use crate::domain::{AppRegistration, AppUrl, AppsError, CloudAppConfiguration, CloudInsertError};

diesel::table! {
    cloud_app_configurations (id) {
        id -> Text,
        url -> Text,
    }
}

// This configuration's PK is a FK into `app_registrations`, so it joins to its
// registration on `id`; the cross-kind `find_app_on` left-joins it there. The
// four-way `allow_tables_to_appear_in_same_query!` lives in `all_kinds_apps`.
diesel::joinable!(cloud_app_configurations -> app_registrations (id));

/// The `cloud_app_configurations` payload — the remote launch URL template. `id` is
/// the FK into `app_registrations`; [`From`] drops it and hands back the payload.
#[derive(Debug, Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = cloud_app_configurations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct CloudConfigurationRow {
    pub(super) id: String,
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub(super) url: AppUrl,
}

impl From<CloudConfigurationRow> for CloudAppConfiguration {
    fn from(row: CloudConfigurationRow) -> Self {
        CloudAppConfiguration { url: row.url }
    }
}

/// Insert a fresh cloud app from a caller-built `registration` + `config`. The
/// store owns the display `position` (assigned at the tail, overriding whatever the
/// caller passed); every other registration field is used as given, and the
/// `cloud_app_configurations` payload is the `config`'s `url` — all in one
/// transaction.
///
/// Returns `Ok(Err(CloudInsertError::IdTaken))` when the id is already taken (no row
/// is written), else the inserted `(registration, configuration)` pair, hydrated from
/// the two inserts' `RETURNING`.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn insert_cloud_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    config: &CloudAppConfiguration,
) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError> {
    // IMMEDIATE so the `next_position` read + inserts can't race a concurrent create —
    // see the transaction-discipline section of `docs/Apps/Store and Install Explanation.md`.
    conn.immediate_transaction(|conn| {
        if id_taken(conn, &registration.id)? {
            return Ok(Err(CloudInsertError::IdTaken));
        }
        // The store owns `position` (tail append); everything else on the
        // registration is the caller's.
        let stored_registration: AppRegistration = diesel::insert_into(app_registrations::table)
            .values(AppRegistration {
                position: next_position(conn)?,
                ..registration.clone()
            })
            .returning(AppRegistration::as_returning())
            .get_result(conn)
            .map_err(|e| AppsError::infrastructure("cloud registration insert failed", e))?;
        let stored_config: CloudConfigurationRow =
            diesel::insert_into(cloud_app_configurations::table)
                .values(CloudConfigurationRow {
                    id: registration.id.clone(),
                    url: config.url.clone(),
                })
                .returning(CloudConfigurationRow::as_returning())
                .get_result(conn)
                .map_err(|e| AppsError::infrastructure("cloud configuration insert failed", e))?;
        Ok(Ok((stored_registration, stored_config.into())))
    })
}

/// Replace a cloud app's editable fields from a caller-built `registration` +
/// `config`, located by `registration.id`: the registration's `name` / `subtitle` /
/// `requires_tunnel` and the `cloud_app_configurations` `url`. **Never touches
/// `on_homescreen` / position** (the placement single-writer) or the other
/// registration columns.
///
/// Returns `Ok(None)` when no cloud app has this id (the `cloud_app_configurations`
/// update affects no row), else the updated `(registration, configuration)` pair,
/// hydrated from the two updates' `RETURNING`.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn replace_cloud_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    config: &CloudAppConfiguration,
) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError> {
    let id = registration.id.as_str();
    // DEFERRED is safe: the first statement is a write (not an allocation read), so its
    // lock is taken before anything it reads — see transaction-discipline in
    // `docs/Apps/Store and Install Explanation.md`.
    conn.transaction(|conn| {
        // The payload update decides existence: a non-cloud or unknown id matches no
        // `cloud_app_configurations` row, so nothing (including the registration) is
        // touched. `RETURNING` re-decodes the stored `url`.
        let updated_config: Option<CloudConfigurationRow> =
            diesel::update(cloud_app_configurations::table.find(id))
                .set(cloud_app_configurations::url.eq(config.url.to_string()))
                .returning(CloudConfigurationRow::as_returning())
                .get_result(conn)
                .optional()
                .map_err(|e| AppsError::infrastructure("cloud configuration update failed", e))?;
        let Some(config_row) = updated_config else {
            return Ok(None);
        };
        // Only the editable registration subset — never placement / kind / client_id
        // / local_only.
        let stored_registration: AppRegistration =
            diesel::update(app_registrations::table.find(id))
                .set((
                    app_registrations::name.eq(&registration.name),
                    app_registrations::subtitle.eq(&registration.subtitle),
                    app_registrations::requires_tunnel.eq(registration.requires_tunnel),
                ))
                .returning(AppRegistration::as_returning())
                .get_result(conn)
                .map_err(|e| AppsError::infrastructure("cloud registration update failed", e))?;
        Ok(Some((stored_registration, config_row.into())))
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{cloud_config, cloud_registration, external};
    use crate::db::SqliteAppsStore;
    use crate::domain::{AppConfiguration, AppKind, AppUrl, AppsStore, CloudInsertError};

    #[test]
    fn insert_cloud_app_returns_the_whole_app_and_round_trips() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (registration, config) = store
            .insert_cloud_app(
                &cloud_registration("app-x"),
                &cloud_config(external("https://example.com/launch")),
            )
            .unwrap()
            .expect("inserted");
        assert_eq!(
            store.find_app("app-x").unwrap(),
            Some((
                registration.clone(),
                AppConfiguration::Cloud(config.clone())
            )),
        );
        assert_eq!(registration.kind, AppKind::Cloud);
        assert_eq!(
            registration.position, 9,
            "the store assigns the tail position"
        );
        assert!(registration.on_homescreen);
        assert!(!registration.local_only);
        assert!(
            !registration.is_smart(),
            "inserted cloud app has no client_id"
        );
        assert_eq!(config.url, external("https://example.com/launch"));
        assert!(!registration.requires_tunnel);
    }

    #[test]
    fn insert_cloud_app_reports_id_taken_on_duplicate_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registration = cloud_registration("app-x");
        let config = cloud_config(external("https://example.com/x"));
        assert!(store
            .insert_cloud_app(&registration, &config)
            .unwrap()
            .is_ok());
        assert_eq!(
            store.insert_cloud_app(&registration, &config).unwrap(),
            Err(CloudInsertError::IdTaken),
            "second insert with the same id is a no-op",
        );
        let (fetched, _) = store.find_app("app-x").unwrap().unwrap();
        assert_eq!(fetched.position, 9);
    }

    /// A seeded app's id can't be re-created — `app_registrations` already holds it,
    /// so the insert is a no-op `IdTaken` and the original row is untouched.
    #[test]
    fn insert_cloud_app_rejects_a_seeded_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        assert_eq!(
            store
                .insert_cloud_app(
                    &cloud_registration("growth-chart"),
                    &cloud_config(external("https://example.com/x")),
                )
                .unwrap(),
            Err(CloudInsertError::IdTaken),
        );
        let (_, configuration) = store.find_app("growth-chart").unwrap().unwrap();
        assert!(configuration
            .as_cloud()
            .expect("cloud configuration")
            .url
            .to_string()
            .contains("growth-chart-app"));
    }

    #[test]
    fn replace_cloud_app_writes_registration_and_payload() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store
            .insert_cloud_app(
                &cloud_registration("app-x"),
                &cloud_config(external("https://example.com/x")),
            )
            .unwrap()
            .expect("inserted");

        let mut edited = cloud_registration("app-x");
        edited.name = "Renamed".to_owned();
        edited.subtitle = Some("the new subtitle".to_owned());
        edited.requires_tunnel = true;
        let (registration, config) = store
            .replace_cloud_app(
                &edited,
                &cloud_config(AppUrl::OriginRelative("/path".to_owned())),
            )
            .unwrap()
            .expect("replaced");
        assert_eq!(registration.name, "Renamed");
        assert_eq!(registration.subtitle.as_deref(), Some("the new subtitle"));
        assert!(registration.requires_tunnel);
        assert_eq!(config.url, AppUrl::OriginRelative("/path".to_owned()));
        assert_eq!(
            store.find_app("app-x").unwrap(),
            Some((registration, AppConfiguration::Cloud(config))),
        );
    }

    /// A content replace must not touch `on_homescreen` — `PUT /home-screen` is that
    /// flag's single writer — even though the caller-built registration carries the
    /// `on_homescreen = true` default.
    #[test]
    fn replace_cloud_app_leaves_on_homescreen_alone() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store
            .insert_cloud_app(
                &cloud_registration("app-x"),
                &cloud_config(external("https://example.com/x")),
            )
            .unwrap()
            .expect("inserted");

        let entries: Vec<(String, bool)> = store
            .list_registrations()
            .unwrap()
            .iter()
            .map(|reg| (reg.id.clone(), reg.id != "app-x"))
            .collect();
        store
            .replace_placements(&entries)
            .unwrap()
            .expect("permutation");
        let (hidden, _) = store.find_app("app-x").unwrap().unwrap();
        assert!(!hidden.on_homescreen);

        let mut edited = cloud_registration("app-x");
        edited.name = "Renamed".to_owned();
        let (registration, _config) = store
            .replace_cloud_app(&edited, &cloud_config(external("https://example.com/y")))
            .unwrap()
            .expect("replaced");
        assert!(
            !registration.on_homescreen,
            "a content replace must not re-show a hidden app",
        );
    }

    /// `replace_cloud_app` only touches cloud apps — a self-hosted / system id
    /// is a no-op `None`, and mutates nothing.
    #[test]
    fn replace_cloud_app_ignores_non_cloud_ids() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        for id in ["patient-browser", "api-docs"] {
            let replaced = store
                .replace_cloud_app(
                    &cloud_registration(id),
                    &cloud_config(external("https://example.com/tampered")),
                )
                .unwrap();
            assert!(replaced.is_none(), "{id} is not a cloud app");
            let (registration, _) = store.find_app(id).unwrap().unwrap();
            assert_ne!(registration.name, id, "{id} row must be untouched");
        }
    }

    #[test]
    fn replace_cloud_app_returns_none_for_unknown_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        assert!(store
            .replace_cloud_app(
                &cloud_registration("ghost"),
                &cloud_config(external("https://x.example"))
            )
            .unwrap()
            .is_none());
    }
}

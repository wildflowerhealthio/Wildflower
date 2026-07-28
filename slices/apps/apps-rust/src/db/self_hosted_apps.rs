//! Self-hosted apps in the store: the `self_hosted_app_configurations` table, its
//! `port` column mapping and row struct, and the self-hosted mutators + reads. A
//! self-hosted app is an [`AppRegistration`](crate::domain::AppRegistration) paired
//! with a [`SelfHostedAppConfiguration`](crate::domain::SelfHostedAppConfiguration)
//! (the loopback binding + launch-render inputs). Insert takes a registration + a
//! [`SelfHostedAppConfigurationPayload`](crate::domain::SelfHostedAppConfigurationPayload):
//! it uses the caller's id verbatim and allocates the lowest-free port + tail position
//! in-txn, writing `seeded = false` (mapping a taken id / exhausted port space onto
//! `AppsError` itself); a content replace touches only the editable subset. Both hand
//! back the pair via `RETURNING`. The host materializes every self-hosted app once at
//! setup via [`list_self_hosted_apps_on`].

use std::collections::HashSet;

use diesel::deserialize::{self, FromSql, FromSqlRow};
use diesel::expression::AsExpression;
use diesel::prelude::*;
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::Integer;
use diesel::sqlite::{Sqlite, SqliteValue};
use persistence_rust::PooledDieselConnection;

use super::app_registration::{app_registrations, id_taken, next_position};
use crate::domain::{
    lowest_free_port, AppRegistration, AppsError, SelfHostedAppConfiguration,
    SelfHostedAppConfigurationPayload, MIN_UPLOAD_PORT,
};

diesel::table! {
    self_hosted_app_configurations (id) {
        id -> Text,
        port -> Integer,
        content_folder -> Text,
        subdomain -> Text,
        seeded -> Bool,
        launch_path -> Nullable<Text>,
    }
}

// This configuration's PK is a FK into `app_registrations`, so it joins to its
// registration on `id` — `list_self_hosted_apps_on`'s inner join and the cross-kind
// `find_app_on`'s left join both rely on this. The four-way
// `allow_tables_to_appear_in_same_query!` lives in `all_kinds_apps`.
diesel::joinable!(self_hosted_app_configurations -> app_registrations (id));

/// A `u16` port bound to / read from an `INTEGER` column. `SQLite` integers are
/// `i64`; diesel reads them as `i32`, so the read narrows to `u16` and rejects an
/// out-of-range stored value (the table's `CHECK (port BETWEEN 1 AND 65535)` keeps
/// that unreachable for rows this crate writes).
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Integer)]
pub(super) struct PortColumn(u16);

impl From<u16> for PortColumn {
    fn from(port: u16) -> Self {
        Self(port)
    }
}

impl From<PortColumn> for u16 {
    fn from(column: PortColumn) -> Self {
        column.0
    }
}

impl FromSql<Integer, Sqlite> for PortColumn {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let raw = <i32 as FromSql<Integer, Sqlite>>::from_sql(value)?;
        Ok(Self(u16::try_from(raw)?))
    }
}

impl ToSql<Integer, Sqlite> for PortColumn {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(i32::from(self.0));
        Ok(IsNull::No)
    }
}

/// The `self_hosted_app_configurations` payload — the loopback binding and
/// launch-render inputs. `id` is the FK into `app_registrations`; [`From`] drops it
/// and hands back the payload.
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

/// Insert a fresh uploaded self-hosted app from a caller-built `registration` + create
/// `payload`, mirroring [`insert_cloud_app`](super::cloud_apps::insert_cloud_app): the
/// `app_registrations` registration AND its `self_hosted_app_configurations` payload,
/// in one transaction. The `registration.id` becomes the row's `id` and
/// `payload.subdomain` its `subdomain`, both verbatim — a clash with the global id
/// space is rejected rather than suffixed. The store owns the display `position`
/// (tail append) and the loopback `port` (lowest free from [`lowest_free_port`] over
/// `reserved_ports` + the taken set), both allocated **inside** the transaction, and
/// writes `seeded = false` (an upload is never seeded). On success the inserted
/// `(registration, configuration)` pair is hydrated from the two inserts' `RETURNING`.
///
/// # Errors
///
/// [`AppsError::InvalidName`] when the id is already taken (nothing written);
/// [`AppsError::Infrastructure`] when the port space is exhausted, or on a checkout /
/// transaction failure.
pub(super) fn insert_self_hosted_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    payload: &SelfHostedAppConfigurationPayload,
    reserved_ports: &[u16],
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    // IMMEDIATE so the port / position reads + inserts can't race a concurrent create —
    // see the transaction-discipline section of `docs/Apps/Store and Install Explanation.md`.
    conn.immediate_transaction(|conn| {
        // The id is the caller's, used verbatim. Reject a clash rather than
        // discovering a free variant — the check runs inside the transaction so it
        // can't race a concurrent insert. A name-derived id clash is a client-fixable
        // `400 InvalidName`. (Every *uploaded* self-hosted row's subdomain equals its
        // id, so the global id space subsumes the subdomain space; the
        // `UNIQUE(subdomain)` column stays a backstop. The seeded rows are the
        // exception — `wildflower-medication` serves at `medication` — and their
        // migrations lean on that: the id is a seed's fallback subdomain.)
        if id_taken(conn, &registration.id)? {
            return Err(AppsError::InvalidName {
                message: "an app with this name already exists".to_owned(),
            });
        }

        // The store owns `port` (lowest-free) and `position` (tail). An exhausted port
        // space is a server resource fault, not a name problem — a logged 500.
        let taken_ports = all_self_hosted_ports(conn)?;
        let Some(port) = lowest_free_port(&taken_ports, reserved_ports, MIN_UPLOAD_PORT, u16::MAX)
        else {
            return Err(AppsError::infrastructure(
                "no free loopback port for a new self-hosted app",
                "port space exhausted",
            ));
        };
        let position = next_position(conn)?;

        let stored_registration: AppRegistration = diesel::insert_into(app_registrations::table)
            .values(AppRegistration {
                position,
                ..registration.clone()
            })
            .returning(AppRegistration::as_returning())
            .get_result(conn)
            .map_err(|e| AppsError::infrastructure("self-hosted registration insert failed", e))?;
        let stored_config: SelfHostedConfigurationRow =
            diesel::insert_into(self_hosted_app_configurations::table)
                .values(SelfHostedConfigurationRow {
                    id: registration.id.clone(),
                    port,
                    content_folder: payload.content_folder.clone(),
                    subdomain: payload.subdomain.clone(),
                    seeded: false,
                    launch_path: payload.launch_path.clone(),
                })
                .returning(SelfHostedConfigurationRow::as_returning())
                .get_result(conn)
                .map_err(|e| {
                    AppsError::infrastructure("self-hosted configuration insert failed", e)
                })?;
        Ok((stored_registration, stored_config.into()))
    })
}

/// Replace a self-hosted app's editable fields from a caller-built `registration` +
/// `payload`, located by `registration.id`: the registration's `name` / `subtitle`
/// and the payload's `launch_path` (`None` clears it back to root-serving).
/// **Never touches placement or the immutable `port` / `subdomain` / `seeded` /
/// `content_folder`** — the payload's `content_folder` / `subdomain` are create-only
/// and ignored here. Returns `Ok(None)` when no self-hosted app has this id, else the
/// updated pair hydrated from the two updates' `RETURNING`. The action layer enforces
/// "not seeded" before calling this.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn replace_self_hosted_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    payload: &SelfHostedAppConfigurationPayload,
) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
    let id = registration.id.as_str();
    // DEFERRED is safe: the first statement is a write (not an allocation read), so its
    // lock is taken before anything it reads — see transaction-discipline in
    // `docs/Apps/Store and Install Explanation.md`.
    conn.transaction(|conn| {
        // The `launch_path` update decides existence: a non-self-hosted or unknown id
        // matches no row.
        let updated_config: Option<SelfHostedConfigurationRow> =
            diesel::update(self_hosted_app_configurations::table.find(id))
                .set(self_hosted_app_configurations::launch_path.eq(payload.launch_path.as_deref()))
                .returning(SelfHostedConfigurationRow::as_returning())
                .get_result(conn)
                .optional()
                .map_err(|e| {
                    AppsError::infrastructure("self-hosted configuration update failed", e)
                })?;
        let Some(config_row) = updated_config else {
            return Ok(None);
        };
        // Only the editable registration subset — never placement or the immutable
        // self-hosted columns.
        let stored_registration: AppRegistration =
            diesel::update(app_registrations::table.find(id))
                .set((
                    app_registrations::name.eq(&registration.name),
                    app_registrations::subtitle.eq(&registration.subtitle),
                ))
                .returning(AppRegistration::as_returning())
                .get_result(conn)
                .map_err(|e| {
                    AppsError::infrastructure("self-hosted registration update failed", e)
                })?;
        Ok(Some((stored_registration, config_row.into())))
    })
}

/// Every self-hosted app, as `(registration, configuration)` pairs, in display
/// order — a typed inner join `self_hosted_app_configurations ⋈ app_registrations`.
/// The host materializes this once at setup to bind a loopback listener per app;
/// ordering by position keeps the bind order stable.
pub(super) fn list_self_hosted_apps_on(
    conn: &mut SqliteConnection,
) -> Result<Vec<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
    let rows: Vec<(SelfHostedConfigurationRow, AppRegistration)> =
        self_hosted_app_configurations::table
            .inner_join(app_registrations::table)
            .order(app_registrations::position)
            .select((
                SelfHostedConfigurationRow::as_select(),
                AppRegistration::as_select(),
            ))
            .load(conn)
            .map_err(|e| AppsError::infrastructure("self-hosted list failed", e))?;
    Ok(rows
        .into_iter()
        .map(|(row, registration)| (registration, row.into()))
        .collect())
}

/// Every loopback port already handed to a self-hosted app as a set — the port
/// allocator's taken input. A stored port outside `u16` can't occur (the column is
/// `CHECK (port BETWEEN 1 AND 65535)`), so an out-of-range value is dropped.
fn all_self_hosted_ports(conn: &mut SqliteConnection) -> Result<HashSet<u16>, AppsError> {
    Ok(self_hosted_app_configurations::table
        .select(self_hosted_app_configurations::port)
        .load::<i32>(conn)
        .map_err(|e| AppsError::infrastructure("self-hosted ports read failed", e))?
        .into_iter()
        .filter_map(|p| u16::try_from(p).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{insert_upload, launch_path, new_upload, replace_payload};
    use crate::db::SqliteAppsStore;
    use crate::domain::{AppKind, AppsError, AppsStore};

    /// An inserted upload lands at the lowest free upload port (8082 — the seeded
    /// self-hosted apps sit at 8081, 8090, and 8091, all outside the start of the
    /// 8082+ climb), and appends at the next position (after the eight seeded rows
    /// → 8), non-seeded.
    #[test]
    fn insert_self_hosted_allocates_the_next_port_and_position() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (registration, config) = insert_upload(&store, "My App", "my-app");
        assert_eq!(registration.id, "my-app");
        assert_eq!(registration.name, "My App");
        assert_eq!(registration.position, 8);
        assert!(registration.local_only);
        assert!(registration.on_homescreen);
        assert_eq!(registration.kind, AppKind::SelfHosted);
        assert_eq!(config.port, 8082);
        assert_eq!(
            config.content_folder, "my-app-folder",
            "content_folder is recorded verbatim from the spec, not the slug",
        );
        assert_eq!(config.subdomain, "my-app");
        assert!(!config.seeded);

        let (registration2, config2) = insert_upload(&store, "Other", "other");
        assert_eq!(config2.port, 8083);
        assert_eq!(registration2.position, 9);
    }

    /// A `launch_path` supplied at insert round-trips through both the insert
    /// return and a fresh `find`; an app inserted without one reads back `None`.
    #[test]
    fn insert_self_hosted_persists_and_reads_back_the_launch_path() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let template = "/launch.html?launch={launch}&iss={origin}/fhir-r4";
        let (registration, mut config) = new_upload("Launcher", "launcher");
        config.launch_path = Some(template.to_owned());
        let inserted = store
            .insert_self_hosted_app(&registration, &config, &[])
            .expect("inserted");
        assert_eq!(launch_path(&inserted).as_deref(), Some(template));

        let (_, configuration) = store.find_app("launcher").unwrap().expect("found");
        assert_eq!(
            configuration
                .as_self_hosted()
                .unwrap()
                .launch_path
                .as_deref(),
            Some(template),
        );

        let rootless = insert_upload(&store, "Rootless", "rootless");
        assert_eq!(launch_path(&rootless), None);
    }

    /// `replace_self_hosted_app` sets, replaces, and clears the launch path; an
    /// unknown id matches nothing.
    #[test]
    fn replace_self_hosted_app_sets_replaces_and_clears() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (registration, _config) = insert_upload(&store, "App", "app");

        let set = store
            .replace_self_hosted_app(&registration, &replace_payload(Some("/launch.html")))
            .unwrap()
            .expect("updated");
        assert_eq!(launch_path(&set).as_deref(), Some("/launch.html"));

        let cleared = store
            .replace_self_hosted_app(&registration, &replace_payload(None))
            .unwrap()
            .expect("updated");
        assert_eq!(launch_path(&cleared), None);

        let ghost = crate::domain::AppRegistration {
            id: "ghost".to_owned(),
            ..registration.clone()
        };
        assert!(
            store
                .replace_self_hosted_app(&ghost, &replace_payload(Some("/launch.html")))
                .unwrap()
                .is_none(),
            "an unknown id matches no row",
        );
    }

    /// A reserved port (the host loopback port) is skipped in the allocation.
    #[test]
    fn insert_self_hosted_skips_reserved_ports() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (registration, config) = new_upload("My App", "my-app");
        let (_registration, config) = store
            .insert_self_hosted_app(&registration, &config, &[8082])
            .expect("inserted");
        assert_eq!(config.port, 8083);
    }

    /// A second upload with an already-taken slug is rejected `InvalidName` — nothing
    /// is written and the original row is untouched.
    #[test]
    fn insert_self_hosted_reports_invalid_name_on_duplicate_slug() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        insert_upload(&store, "My App", "my-app");

        let (registration, mut config) = new_upload("My App", "my-app");
        config.content_folder = "my-app-folder-2".to_owned();
        assert!(
            matches!(
                store.insert_self_hosted_app(&registration, &config, &[]),
                Err(AppsError::InvalidName { .. }),
            ),
            "a taken id is a no-op InvalidName, not a suffixed variant",
        );
        // The original row's port is still the sole 8082 allocation.
        let (_, configuration) = store.find_app("my-app").unwrap().unwrap();
        assert_eq!(configuration.as_self_hosted().unwrap().port, 8082);
    }

    /// A freed port is reused (lowest-free allocation).
    #[test]
    fn freed_ports_are_reused_lowest_first() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (_first, config1) = insert_upload(&store, "First", "first");
        let (_second, config2) = insert_upload(&store, "Second", "second");
        assert_eq!(config1.port, 8082);
        assert_eq!(config2.port, 8083);

        assert!(store.delete_app("first").unwrap());
        let (_third, config3) = insert_upload(&store, "Third", "third");
        assert_eq!(
            config3.port, 8082,
            "the freed port must be reused, not MAX+1",
        );
    }

    /// A slug colliding with the seeded `patient-browser` is rejected `InvalidName`
    /// — the seed occupies the id space and is never overwritten.
    #[test]
    fn insert_self_hosted_rejects_a_slug_colliding_with_a_seed() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (registration, config) = new_upload("Patient Browser", "patient-browser");
        assert!(matches!(
            store.insert_self_hosted_app(&registration, &config, &[]),
            Err(AppsError::InvalidName { .. }),
        ));
        // The seeded row is untouched (still port 8081, still seeded).
        let (_, configuration) = store.find_app("patient-browser").unwrap().unwrap();
        let config = configuration.as_self_hosted().unwrap();
        assert_eq!(config.port, 8081);
        assert!(config.seeded);
    }

    /// `list_self_hosted_apps` hands back whole self-hosted apps — the seeded
    /// patient-browser with its port, folder, subdomain, and `seeded` flag.
    #[test]
    fn list_self_hosted_apps_returns_the_seeded_patient_browser() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let apps = store.list_self_hosted_apps().unwrap();
        let (registration, config) = apps
            .iter()
            .find(|(reg, _)| reg.id == "patient-browser")
            .expect("patient-browser is seeded");
        assert_eq!(registration.name, "Patient Browser");
        assert_eq!(config.port, 8081);
        assert_eq!(config.content_folder, "patient-browser");
        assert_eq!(config.subdomain, "patient-browser");
        assert!(config.seeded);
        assert!(
            apps.iter().all(|(reg, _)| reg.kind == AppKind::SelfHosted),
            "only self-hosted apps may appear",
        );
    }
}

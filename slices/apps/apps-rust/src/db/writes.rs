//! The store's write side — the `pub(super)` query bodies the
//! [`SqliteAppsStore`](super::SqliteAppsStore) adapter delegates to, each running
//! on a connection the adapter has already checked out of the pool. A create
//! inserts a registration + its one configuration in one transaction; a content
//! edit updates the tables that own the touched fields (a cloud edit: the
//! registration's `name`/`subtitle`/`requires_tunnel` + the
//! `cloud_app_configurations` `url`); a delete is one registration delete (the
//! configuration cascades). Insert/replace take a caller-built
//! `(registration, configuration)` (a self-hosted upload keeps its allocation spec,
//! since the port and position are store-allocated) and — for create / replace —
//! return the
//! hydrated pair re-read *inside the same transaction* (via
//! [`find_app_on`](super::reads::find_app_on)). The transaction discipline is
//! explained in `docs/Apps/Store and Install Explanation.md`.

use std::collections::HashSet;

use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;

use super::reads::{delete_app_row, find_app_on, id_taken, list_registrations_on, next_position};
use super::row_structs::{CloudConfigurationRow, SelfHostedConfigurationRow};
use super::schema::{app_registrations, cloud_app_configurations, self_hosted_app_configurations};
use crate::domain::{
    is_exact_registry_permutation, lowest_free_port, AppConfiguration, AppRegistration, AppsError,
    CloudAppConfiguration, CloudInsertError, SelfHostedAppConfiguration,
};

/// The smallest loopback port an uploaded app is allocated — one above the seeded
/// patient-browser at 8081. See the port-allocation section of
/// `docs/Apps/Store and Install Explanation.md`.
const MIN_UPLOAD_PORT: u16 = 8082;

/// Insert a fresh cloud app from a caller-built `registration` + `config`. The
/// store owns the display `position` (assigned at the tail, overriding whatever the
/// caller passed); every other registration field is used as given, and the
/// `cloud_app_configurations` payload is the `config`'s `url` — all in one
/// transaction.
///
/// Returns `Ok(Err(CloudInsertError::IdTaken))` when the id is already taken (no row
/// is written), else the inserted `(registration, configuration)` pair read back
/// in-txn.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn insert_cloud_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    config: &CloudAppConfiguration,
) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError> {
    conn.transaction(|conn| {
        if id_taken(conn, &registration.id)? {
            return Ok(Err(CloudInsertError::IdTaken));
        }
        // The store owns `position` (tail append); everything else on the
        // registration is the caller's.
        let to_insert = AppRegistration {
            position: next_position(conn)?,
            ..registration.clone()
        };
        diesel::insert_into(app_registrations::table)
            .values(to_insert)
            .execute(conn)?;
        diesel::insert_into(cloud_app_configurations::table)
            .values(CloudConfigurationRow {
                id: registration.id.clone(),
                url: config.url.clone(),
            })
            .execute(conn)?;
        Ok(Ok(read_back_cloud(conn, &registration.id)?))
    })
}

/// Insert a fresh uploaded self-hosted app from a caller-built `registration` +
/// `config`, mirroring [`insert_cloud_app`]: the `app_registrations` registration
/// AND its `self_hosted_app_configurations` payload, in one transaction. The
/// `registration.id` becomes the row's `id` and the `config.subdomain` its
/// `subdomain`, both verbatim — a clash with the global id space is rejected rather
/// than suffixed. The store owns the display `position` (tail append) and the
/// loopback `port` (lowest free from [`lowest_free_port`] over `reserved_ports` +
/// the taken set), overriding whatever those two fields carry; every other field on
/// the pair is used as given. Position and port are allocated **inside** the
/// transaction. On success the inserted `(registration, configuration)` pair is read
/// back in-txn.
///
/// # Errors
///
/// [`AppsError::InvalidName`] when the id is already taken (nothing written);
/// [`AppsError::Infrastructure`] when the port space is exhausted, or on a checkout /
/// transaction failure.
pub(super) fn insert_self_hosted_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    config: &SelfHostedAppConfiguration,
    reserved_ports: &[u16],
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    conn.transaction(|conn| {
        // The id is the caller's, used verbatim. Reject a clash rather than
        // discovering a free variant — the check runs inside the transaction so it
        // can't race a concurrent insert. A name-derived id clash is a client-fixable
        // `400 InvalidName`. (Every self-hosted row's subdomain equals its id, so the
        // global id space subsumes the subdomain space; the `UNIQUE(subdomain)`
        // column stays a backstop.)
        if id_taken(conn, &registration.id)? {
            return Err(AppsError::InvalidName {
                message: "an app with this name already exists".to_owned(),
            });
        }

        // The store owns `port` (lowest-free) and `position` (tail); every other
        // field on the caller's pair is used as given. An exhausted port space is a
        // server resource fault, not a name problem — a logged 500.
        let taken_ports = all_self_hosted_ports(conn)?;
        let Some(port) = lowest_free_port(&taken_ports, reserved_ports, MIN_UPLOAD_PORT, u16::MAX)
        else {
            return Err(AppsError::infrastructure(
                "no free loopback port for a new self-hosted app",
                "port space exhausted",
            ));
        };
        let position = next_position(conn)?;

        diesel::insert_into(app_registrations::table)
            .values(AppRegistration {
                position,
                ..registration.clone()
            })
            .execute(conn)?;
        diesel::insert_into(self_hosted_app_configurations::table)
            .values(SelfHostedConfigurationRow {
                id: registration.id.clone(),
                port,
                content_folder: config.content_folder.clone(),
                subdomain: config.subdomain.clone(),
                seeded: config.seeded,
                launch_path: config.launch_path.clone(),
            })
            .execute(conn)?;
        read_back_self_hosted(conn, &registration.id)
    })
}

/// Replace a cloud app's editable fields from a caller-built `registration` +
/// `config`, located by `registration.id`: the registration's `name` / `subtitle` /
/// `requires_tunnel` and the `cloud_app_configurations` `url`. **Never touches
/// `on_homescreen` / position** (the placement single-writer) or the other
/// registration columns.
///
/// Returns `Ok(None)` when no cloud app has this id (the `cloud_app_configurations`
/// update affects no row), else the updated `(registration, configuration)` pair
/// read back in-txn.
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
    conn.transaction(|conn| {
        // The payload update decides existence: a non-cloud or unknown id matches
        // no `cloud_app_configurations` row, so nothing (including the
        // registration) is touched.
        let affected = diesel::update(cloud_app_configurations::table.find(id))
            .set(cloud_app_configurations::url.eq(config.url.to_string()))
            .execute(conn)?;
        if affected != 1 {
            return Ok(None);
        }
        // Only the editable registration subset — never placement / kind / client_id
        // / local_only.
        diesel::update(app_registrations::table.find(id))
            .set((
                app_registrations::name.eq(&registration.name),
                app_registrations::subtitle.eq(&registration.subtitle),
                app_registrations::requires_tunnel.eq(registration.requires_tunnel),
            ))
            .execute(conn)?;
        Ok(Some(read_back_cloud(conn, id)?))
    })
}

/// Replace a self-hosted app's editable fields from a caller-built `registration` +
/// `config`, located by `registration.id`: the registration's `name` / `subtitle`
/// and the configuration's `launch_path` (`None` clears it back to root-serving).
/// **Never touches placement or the immutable `port` / `subdomain` / `seeded` /
/// `content_folder`.** Returns `Ok(None)` when no self-hosted app has this id, else
/// the updated pair read back in-txn. The action layer enforces "not seeded" before
/// calling this.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn replace_self_hosted_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
    config: &SelfHostedAppConfiguration,
) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
    let id = registration.id.as_str();
    conn.transaction(|conn| {
        // The `launch_path` update decides existence: a non-self-hosted or unknown
        // id matches no row.
        let affected = diesel::update(self_hosted_app_configurations::table.find(id))
            .set(self_hosted_app_configurations::launch_path.eq(config.launch_path.as_deref()))
            .execute(conn)?;
        if affected != 1 {
            return Ok(None);
        }
        // Only the editable registration subset — never placement or the immutable
        // self-hosted columns.
        diesel::update(app_registrations::table.find(id))
            .set((
                app_registrations::name.eq(&registration.name),
                app_registrations::subtitle.eq(&registration.subtitle),
            ))
            .execute(conn)?;
        Ok(Some(read_back_self_hosted(conn, id)?))
    })
}

/// Delete an app by id, any kind — one registration delete; the configuration
/// cascades. Returns `true` when a row was removed. The handlers enforce the
/// removability policy (kind + seeded) before calling this.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn delete_app(conn: &mut PooledDieselConnection, id: &str) -> Result<bool, AppsError> {
    conn.transaction(|conn| delete_app_row(conn, id))
}

/// Atomically validate **and** rewrite the whole homescreen placement — the
/// ordering **and** the `on_homescreen` flags — in one transaction over
/// `app_registrations`. The body must list every registry app exactly once; each
/// `(id, on_homescreen)` at index `i` sets that row's `position = i` and
/// `on_homescreen`. Returns the resulting registry in its new order (read inside the
/// same transaction), or `Ok(None)` when `entries` isn't an exact permutation of
/// the live registry — the caller maps that to `400 InvalidHomeScreen`.
///
/// The sole writer of `position` / `on_homescreen` across every kind. See the
/// single-writer section of `docs/Apps/Store and Install Explanation.md`.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn replace_placements(
    conn: &mut PooledDieselConnection,
    entries: &[(String, bool)],
) -> Result<Option<Vec<AppRegistration>>, AppsError> {
    conn.transaction(|conn| {
        // Validate against the live registry under the same transaction as the
        // renumber: the body must be an exact permutation of the current ids. The
        // set logic is a pure domain function; here we only supply the two id sets.
        let current_ids = all_registration_ids(conn)?;
        let body_ids: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        if !is_exact_registry_permutation(&current_ids, &body_ids) {
            return Ok(None);
        }

        // Move every row to a disjoint negative range first so the per-row
        // renumber below never transiently violates `UNIQUE(position)`
        // (SQLite's UNIQUE is immediate, not deferrable).
        diesel::sql_query("UPDATE app_registrations SET position = -1 - position").execute(conn)?;
        for (index, (id, on_homescreen)) in entries.iter().enumerate() {
            // A registry with more than i64::MAX apps can't exist, but map rather
            // than panic so any conversion failure rolls the transaction back.
            let position = i64::try_from(index)
                .map_err(|e| AppsError::infrastructure("home-screen index exceeds i64", e))?;
            diesel::update(app_registrations::table.find(id))
                .set((
                    app_registrations::position.eq(position),
                    app_registrations::on_homescreen.eq(on_homescreen),
                ))
                .execute(conn)?;
        }

        // Read the new registry inside the transaction so the response can't
        // reflect a write that landed after the renumber.
        let updated = list_registrations_on(conn)?;
        Ok(Some(updated))
    })
}

/// Re-read a just-written cloud app as its `(registration, configuration)` pair,
/// inside the writing transaction. A miss / wrong kind can't happen (the caller
/// just wrote a cloud row) — it's a corrupt registry, surfaced as a logged 500.
fn read_back_cloud(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    match find_app_on(conn, id)? {
        Some((registration, AppConfiguration::Cloud(config))) => Ok((registration, config)),
        _ => Err(AppsError::infrastructure(
            "read_back_cloud",
            format!("cloud row {id} vanished or changed kind after write"),
        )),
    }
}

/// Re-read a just-written self-hosted app as its `(registration, configuration)`
/// pair, inside the writing transaction. A miss / wrong kind can't happen — it's a
/// corrupt registry, surfaced as a logged 500.
fn read_back_self_hosted(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    match find_app_on(conn, id)? {
        Some((registration, AppConfiguration::SelfHosted(config))) => Ok((registration, config)),
        _ => Err(AppsError::infrastructure(
            "read_back_self_hosted",
            format!("self-hosted row {id} vanished or changed kind after write"),
        )),
    }
}

/// Every registration id (the global app-id space) as a set — the home-screen
/// permutation check's live-registry input, read inside the placement transaction.
fn all_registration_ids(conn: &mut SqliteConnection) -> Result<HashSet<String>, AppsError> {
    Ok(app_registrations::table
        .select(app_registrations::id)
        .load::<String>(conn)?
        .into_iter()
        .collect())
}

/// Every loopback port already handed to a self-hosted app as a set — the port
/// allocator's taken input. A stored port outside `u16` can't occur (the column is
/// `CHECK (port BETWEEN 1 AND 65535)`), so an out-of-range value is dropped.
fn all_self_hosted_ports(conn: &mut SqliteConnection) -> Result<HashSet<u16>, AppsError> {
    Ok(self_hosted_app_configurations::table
        .select(self_hosted_app_configurations::port)
        .load::<i32>(conn)?
        .into_iter()
        .filter_map(|p| u16::try_from(p).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use crate::db::SqliteAppsStore;
    // The port trait is in scope so the concrete adapter's mutator methods resolve.
    use crate::domain::{
        AppConfiguration, AppKind, AppRegistration, AppUrl, AppsError, AppsStore,
        CloudAppConfiguration, CloudInsertError, SelfHostedAppConfiguration,
    };

    /// A caller-built cloud registration (the shape the HTTP layer hands the store):
    /// kind `cloud`, on the home screen, `position` a placeholder the store
    /// overrides. `name` defaults to the id.
    fn cloud_registration(id: &str) -> AppRegistration {
        AppRegistration {
            id: id.to_owned(),
            kind: AppKind::Cloud,
            position: 0,
            on_homescreen: true,
            name: id.to_owned(),
            subtitle: None,
            local_only: false,
            client_id: None,
            requires_tunnel: false,
        }
    }

    fn cloud_config(url: AppUrl) -> CloudAppConfiguration {
        CloudAppConfiguration { url }
    }

    /// A caller-built self-hosted upload pair (the shape the HTTP layer hands the
    /// store): id = subdomain = `slug`, non-seeded, `position` / `port` placeholders
    /// the store overrides. `content_folder` defaults to `<slug>-folder`.
    fn new_upload(name: &str, slug: &str) -> (AppRegistration, SelfHostedAppConfiguration) {
        (
            AppRegistration {
                id: slug.to_owned(),
                kind: AppKind::SelfHosted,
                position: 0,
                on_homescreen: true,
                name: name.to_owned(),
                subtitle: None,
                local_only: true,
                client_id: None,
                requires_tunnel: false,
            },
            SelfHostedAppConfiguration {
                port: 0,
                content_folder: format!("{slug}-folder"),
                subdomain: slug.to_owned(),
                seeded: false,
                launch_path: None,
            },
        )
    }

    /// Insert an upload pair with no reserved ports — the common no-customization
    /// path — returning the stored pair.
    fn insert_upload(
        store: &SqliteAppsStore,
        name: &str,
        slug: &str,
    ) -> (AppRegistration, SelfHostedAppConfiguration) {
        let (registration, config) = new_upload(name, slug);
        store
            .insert_self_hosted_app(&registration, &config, &[])
            .expect("inserted")
    }

    fn external(url: &str) -> AppUrl {
        AppUrl::External(url.to_owned())
    }

    /// The `launch_path` of a self-hosted `(registration, configuration)` pair.
    fn launch_path(
        pair: &(crate::domain::AppRegistration, SelfHostedAppConfiguration),
    ) -> Option<String> {
        pair.1.launch_path.clone()
    }

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
            registration.position, 6,
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
        assert_eq!(fetched.position, 6);
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

    /// An inserted upload lands one port above the seed (8081 → 8082), appends at
    /// the next position (after the six seeded rows → 6), and is non-seeded.
    #[test]
    fn insert_self_hosted_allocates_the_next_port_and_position() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let (registration, config) = insert_upload(&store, "My App", "my-app");
        assert_eq!(registration.id, "my-app");
        assert_eq!(registration.name, "My App");
        assert_eq!(registration.position, 6);
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
        assert_eq!(registration2.position, 7);
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
        let (registration, config) = insert_upload(&store, "App", "app");

        let with_path = SelfHostedAppConfiguration {
            launch_path: Some("/launch.html".to_owned()),
            ..config.clone()
        };
        let set = store
            .replace_self_hosted_app(&registration, &with_path)
            .unwrap()
            .expect("updated");
        assert_eq!(launch_path(&set).as_deref(), Some("/launch.html"));

        let cleared = store
            .replace_self_hosted_app(
                &registration,
                &SelfHostedAppConfiguration {
                    launch_path: None,
                    ..config.clone()
                },
            )
            .unwrap()
            .expect("updated");
        assert_eq!(launch_path(&cleared), None);

        let ghost = AppRegistration {
            id: "ghost".to_owned(),
            ..registration.clone()
        };
        assert!(
            store
                .replace_self_hosted_app(&ghost, &with_path)
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

    /// Delete removes the registration and cascades the configuration, for either
    /// kind.
    #[test]
    fn delete_app_removes_registration_and_cascades_configuration() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let (registration, _config) = insert_upload(&store, "My App", "my-app");
        assert!(store.delete_app(&registration.id).unwrap());
        assert!(store.find_app("my-app").unwrap().is_none());
        assert!(
            !store.delete_app("my-app").unwrap(),
            "a second delete of the same id removes nothing",
        );

        assert!(store.delete_app("growth-chart").unwrap());
        assert!(store.find_app("growth-chart").unwrap().is_none());
        let mut conn = store.pool().get().unwrap();
        let child_count: i64 = super::cloud_app_configurations::table
            .filter(super::cloud_app_configurations::id.eq("growth-chart"))
            .count()
            .get_result(&mut conn)
            .unwrap();
        assert_eq!(child_count, 0, "the configuration cascaded");

        assert!(!store.delete_app("no-such-id").unwrap());
    }

    /// The removability matrix over live rows: cloud + uploaded self-hosted are
    /// removable; system + seeded self-hosted are not.
    #[test]
    fn removable_per_kind_and_seeded_on_live_rows() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        insert_upload(&store, "My App", "my-app");
        let by_id = |id: &str| store.find_app(id).unwrap().expect("row").1;
        assert!(
            by_id("my-app").is_removable(),
            "an uploaded app is removable"
        );
        assert!(
            by_id("growth-chart").is_removable(),
            "a cloud app is removable"
        );
        assert!(
            !by_id("patient-browser").is_removable(),
            "the seeded self-hosted app is not removable",
        );
        assert!(
            !by_id("api-docs").is_removable(),
            "a system app is not removable"
        );
    }

    /// `replace_placements` renumbers every row to its array index and applies
    /// each `on_homescreen` flag, in one shot, for any kind — leaving a dense `0..n`
    /// permutation (no ties).
    #[test]
    fn replace_placements_renumbers_and_sets_on_homescreen_for_any_kind() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let entries: Vec<(String, bool)> = vec![
            ("precise-hbr".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("api-docs".to_owned(), false),
            ("api-view".to_owned(), true),
            ("patient-browser".to_owned(), true),
        ];
        let updated = store
            .replace_placements(&entries)
            .unwrap()
            .expect("an exact permutation renumbers and returns the registry");

        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|r| r.id.clone()).collect();
        assert_eq!(returned_ids, expected);

        for (position, (id, _)) in entries.iter().enumerate() {
            let (registration, _) = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                registration.position,
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        let (api_docs, _) = store.find_app("api-docs").unwrap().unwrap();
        assert!(!api_docs.on_homescreen);
        let ids: Vec<String> = store
            .list_registrations()
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(ids, expected);
    }

    /// A body that isn't an exact permutation of the live registry returns
    /// `Ok(None)` (→ `400`) and writes nothing.
    #[test]
    fn replace_placements_rejects_a_non_permutation_without_writing() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let ids_now = |store: &SqliteAppsStore| -> Vec<String> {
            store
                .list_registrations()
                .unwrap()
                .iter()
                .map(|r| r.id.clone())
                .collect()
        };
        let before = ids_now(&store);

        let subset = vec![("api-view".to_owned(), true), ("api-docs".to_owned(), true)];
        assert!(store.replace_placements(&subset).unwrap().is_none());

        let dup = vec![
            ("patient-browser".to_owned(), true),
            ("api-view".to_owned(), true),
            ("api-docs".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("api-view".to_owned(), true),
        ];
        assert!(store.replace_placements(&dup).unwrap().is_none());

        assert_eq!(
            before,
            ids_now(&store),
            "a rejected body must not reorder anything"
        );
    }
}

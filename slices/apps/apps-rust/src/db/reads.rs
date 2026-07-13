//! The store's read side — typed diesel queries against the real registration +
//! configuration tables. The uniform catalogue read is a join-free
//! `SELECT * FROM app_registrations ORDER BY position` decoded into
//! [`AppRegistration`]s; a detail read reads the registration then the one
//! configuration its `kind` names and composes the whole [`App`] pair. Every read
//! is a typed query against real tables, and the one invariant SQLite can't enforce
//! (registration ⇒ its configuration row exists) is checked at the single detail
//! read as a typed error.

use diesel::prelude::*;

use super::payloads::{CloudConfigurationRow, SelfHostedConfigurationRow, SystemConfigurationRow};
use super::schema::{
    app_registrations, cloud_app_configurations, self_hosted_app_configurations,
    system_app_configurations,
};
use crate::domain::{
    App, AppKind, AppRegistration, AppsError, CloudAppConfiguration, SelfHostedAppConfiguration,
    SystemAppConfiguration,
};

/// The uniform catalogue read against an arbitrary connection — shared by the
/// [`SqliteAppsStore`](super::SqliteAppsStore) `list_registrations` delegation and
/// the placement transaction (which calls it on its open transaction so the
/// post-renumber read stays in the same transaction). Join-free: the registration
/// carries everything the homescreen tile renders.
pub(super) fn list_registrations_on(
    conn: &mut SqliteConnection,
) -> Result<Vec<AppRegistration>, AppsError> {
    Ok(app_registrations::table
        .order(app_registrations::position)
        .select(AppRegistration::as_select())
        .load(conn)?)
}

/// The registration ⇒ configuration invariant SQLite can't enforce across tables: a
/// registration says `kind` but the named configuration table has no row for its
/// id. A corrupt registry — surfaces as a typed [`AppsError::Infrastructure`] (a
/// logged 500), never a partial [`App`].
fn missing_configuration(id: &str, kind: AppKind) -> AppsError {
    AppsError::infrastructure(
        "app_registrations row has no matching configuration",
        format!("id={id} names kind {kind} but its {kind}_app_configurations row is missing"),
    )
}

/// The single-app detail read against an arbitrary connection — the registration
/// plus the one configuration its `kind` names, composed into an [`App`] pair. What
/// every store mutator calls **on its own open transaction** to return the hydrated
/// pair it just wrote, and what the per-kind detail routes read. `Ok(None)` when no
/// registration has this id; a registration whose configuration row is missing is a
/// corrupt registry → [`missing_configuration`].
pub(super) fn find_app_on(conn: &mut SqliteConnection, id: &str) -> Result<Option<App>, AppsError> {
    let Some(registration): Option<AppRegistration> = app_registrations::table
        .find(id)
        .select(AppRegistration::as_select())
        .first(conn)
        .optional()?
    else {
        return Ok(None);
    };

    let app = match registration.kind {
        AppKind::System => {
            let row: SystemConfigurationRow = system_app_configurations::table
                .find(id)
                .select(SystemConfigurationRow::as_select())
                .first(conn)
                .optional()?
                .ok_or_else(|| missing_configuration(id, AppKind::System))?;
            App::System(registration, SystemAppConfiguration { url: row.url })
        }
        AppKind::Cloud => {
            let row: CloudConfigurationRow = cloud_app_configurations::table
                .find(id)
                .select(CloudConfigurationRow::as_select())
                .first(conn)
                .optional()?
                .ok_or_else(|| missing_configuration(id, AppKind::Cloud))?;
            App::Cloud(registration, CloudAppConfiguration { url: row.url })
        }
        AppKind::SelfHosted => {
            let row: SelfHostedConfigurationRow = self_hosted_app_configurations::table
                .find(id)
                .select(SelfHostedConfigurationRow::as_select())
                .first(conn)
                .optional()?
                .ok_or_else(|| missing_configuration(id, AppKind::SelfHosted))?;
            App::SelfHosted(registration, self_hosted_config_from_row(row))
        }
    };
    Ok(Some(app))
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
            .load(conn)?;
    Ok(rows
        .into_iter()
        .map(|(row, registration)| (registration, self_hosted_config_from_row(row)))
        .collect())
}

/// Map a [`SelfHostedConfigurationRow`] onto the domain
/// [`SelfHostedAppConfiguration`] — the one place the self-hosted configuration
/// columns map onto the domain type, shared by the detail read and the
/// host-listener list.
fn self_hosted_config_from_row(row: SelfHostedConfigurationRow) -> SelfHostedAppConfiguration {
    SelfHostedAppConfiguration {
        port: row.port,
        content_folder: row.content_folder,
        subdomain: row.subdomain,
        seeded: row.seeded,
        launch_path: row.launch_path,
    }
}

/// Whether any app already holds this id — checked against `app_registrations`, the
/// registration PK and so the global id space across every kind.
pub(super) fn id_taken(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppsError> {
    let taken = diesel::select(diesel::dsl::exists(
        app_registrations::table.filter(app_registrations::id.eq(id)),
    ))
    .get_result::<bool>(conn)?;
    Ok(taken)
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry).
pub(super) fn next_position(conn: &mut SqliteConnection) -> Result<i64, AppsError> {
    let max: Option<i64> = app_registrations::table
        .select(diesel::dsl::max(app_registrations::position))
        .first(conn)?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Delete an app's registration by id; the configuration cascades
/// (`ON DELETE CASCADE`). Returns whether a registration row was removed (i.e. the
/// app existed).
pub(super) fn delete_app_row(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppsError> {
    let removed = diesel::delete(app_registrations::table.find(id)).execute(conn)?;
    Ok(removed == 1)
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use crate::db::SqliteAppsStore;
    // The port trait is in scope so the concrete adapter's read methods resolve.
    use crate::domain::{App, AppKind, AppsStore};

    /// The migration seeds the full default set: 6 registrations in display order
    /// with the right kind.
    #[test]
    fn migration_seeds_the_default_registry() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        let ids: Vec<&str> = registrations.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "patient-browser",
                "api-view",
                "api-docs",
                "growth-chart",
                "medication-viewer",
                "precise-hbr",
            ],
            "seeded apps must come back in position order",
        );
    }

    /// `list_registrations` reports `is_smart` (cloud SMART-client rows),
    /// `local_only` (the loopback ones), `requires_tunnel` (cloud), and the kind per
    /// row.
    #[test]
    fn list_registrations_reports_the_shared_facts_per_row() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        let by_id = |id: &str| {
            registrations
                .iter()
                .find(|r| r.id == id)
                .expect("seeded row")
        };

        for cloud in ["growth-chart", "medication-viewer", "precise-hbr"] {
            let reg = by_id(cloud);
            assert!(reg.is_smart(), "{cloud} must be smart");
            assert_eq!(reg.kind, AppKind::Cloud);
            assert!(reg.requires_tunnel, "{cloud} requires the tunnel");
        }
        for local in ["patient-browser", "api-view", "api-docs"] {
            let reg = by_id(local);
            assert!(reg.local_only, "{local} must be local-only");
            assert!(!reg.is_smart(), "{local} must not be smart");
            assert!(!reg.requires_tunnel, "{local} must not require the tunnel");
        }
        assert_eq!(by_id("patient-browser").kind, AppKind::SelfHosted);
        assert_eq!(by_id("api-view").kind, AppKind::System);
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

    /// `find_app` hydrates the whole app: the registration plus the kind
    /// configuration from its table.
    #[test]
    fn find_app_reads_the_whole_app_per_kind() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let cloud = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(cloud.name(), "Growth Chart");
        assert_eq!(cloud.kind(), AppKind::Cloud);
        assert!(cloud.is_smart());
        assert!(cloud.registration().requires_tunnel);
        let config = cloud.as_cloud().expect("cloud configuration");
        assert!(config.url.to_string().contains("growth-chart-app"));

        let self_hosted = store.find_app("patient-browser").unwrap().expect("seeded");
        let config = self_hosted
            .as_self_hosted()
            .expect("self-hosted configuration");
        assert_eq!(config.port, 8081);
        assert_eq!(config.content_folder, "patient-browser");
        assert_eq!(config.subdomain, "patient-browser");
        assert!(config.seeded);

        let system = store.find_app("api-docs").unwrap().expect("seeded");
        assert_eq!(system.kind(), AppKind::System);
        assert_eq!(system.name(), "API Docs");
        assert_eq!(
            system.as_system_url(),
            Some("{origin}/docs".to_owned()),
            "the system configuration carries the compiled-shell launch template",
        );

        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    /// A registration whose configuration row is gone (raw SQL tampering) is a
    /// typed read error, not a partial `App` — pins the invariant.
    #[test]
    fn missing_configuration_is_a_typed_read_error() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        diesel::sql_query("DELETE FROM cloud_app_configurations WHERE id = 'growth-chart'")
            .execute(&mut conn)
            .unwrap();
        drop(conn);
        let error = store
            .find_app("growth-chart")
            .expect_err("a registration with no configuration must fail the read");
        assert!(
            error_text(&error).contains("no matching configuration"),
            "error should name the invariant: {error:?}",
        );
    }

    /// A stored cloud `url` that no longer parses surfaces as a typed read error
    /// (the [`AppUrlColumn`] deserialize), not a silent unsafe value.
    #[test]
    fn find_app_rejects_an_unparseable_stored_url() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        diesel::sql_query(
            "UPDATE cloud_app_configurations SET url = 'http://evil.example.com' WHERE id = 'growth-chart'",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        assert!(store.find_app("growth-chart").is_err());
    }

    impl App {
        /// Test helper — the system configuration url as a string, `None` for other
        /// kinds.
        fn as_system_url(&self) -> Option<String> {
            self.as_system().map(|config| config.url.to_string())
        }
    }

    fn error_text(error: &crate::domain::AppsError) -> String {
        match error {
            crate::domain::AppsError::Infrastructure { context, source } => {
                format!("{context}: {source}")
            }
            other => format!("{other:?}"),
        }
    }
}

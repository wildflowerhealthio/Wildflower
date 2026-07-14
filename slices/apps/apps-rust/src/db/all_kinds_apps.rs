//! The query bodies that resolve an app of **any** kind — the ones that import from
//! the three per-kind files rather than owning a single kind. [`find_app_on`] reads a
//! registration and its one configuration in a **single atomic left join** across the
//! three configuration tables (composing the `(registration, configuration)` pair the
//! launch / delete seams use); [`delete_app`] removes a registration (its configuration
//! cascades).
//!
//! Because that left join names all four tables in one query, this file owns the
//! four-way `allow_tables_to_appear_in_same_query!` (the per-kind files keep only their
//! `joinable!`) — one declaration, so the pairwise permissions exist without the
//! duplicate impls three separate two-way declarations would produce.

use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;

use super::app_registration::app_registrations;
use super::cloud_apps::{cloud_app_configurations, CloudConfigurationRow};
use super::self_hosted_apps::{self_hosted_app_configurations, SelfHostedConfigurationRow};
use super::system_apps::{system_app_configurations, SystemConfigurationRow};
use crate::domain::{AppConfiguration, AppKind, AppRegistration, AppsError};

diesel::allow_tables_to_appear_in_same_query!(
    app_registrations,
    cloud_app_configurations,
    self_hosted_app_configurations,
    system_app_configurations,
);

/// The registration ⇒ configuration invariant SQLite can't enforce across tables: a
/// registration says `kind` but the named configuration table has no row for its
/// id. A corrupt registry — surfaces as a typed [`AppsError::Infrastructure`] (a
/// logged 500), never a partial pair.
fn missing_configuration(id: &str, kind: AppKind) -> AppsError {
    AppsError::infrastructure(
        "app_registrations row has no matching configuration",
        format!("id={id} names kind {kind} but its {kind}_app_configurations row is missing"),
    )
}

/// One row of the `find_app_on` left join: the registration plus the nullable
/// configuration row of each kind — exactly one is `Some` for a consistent registry.
type JoinedAppRow = (
    AppRegistration,
    Option<CloudConfigurationRow>,
    Option<SelfHostedConfigurationRow>,
    Option<SystemConfigurationRow>,
);

/// The single-app detail read against an arbitrary connection — the registration
/// plus the one configuration its `kind` names, as a `(registration, configuration)`
/// pair (the configuration as the [`AppConfiguration`] union). What the launch /
/// delete seams read. `Ok(None)` when no registration has this id; a registration
/// whose configuration row is missing is a corrupt registry → [`missing_configuration`].
///
/// One statement: a left join to all three configuration tables. So a concurrent
/// delete can't commit between a registration read and a separate configuration read
/// and turn a benign 404 into a false corrupt-registry 500 — the whole pair comes
/// from one atomic snapshot.
pub(super) fn find_app_on(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError> {
    let Some((registration, cloud, self_hosted, system)): Option<JoinedAppRow> =
        app_registrations::table
            .left_join(cloud_app_configurations::table)
            .left_join(self_hosted_app_configurations::table)
            .left_join(system_app_configurations::table)
            .filter(app_registrations::id.eq(id))
            .select((
                AppRegistration::as_select(),
                Option::<CloudConfigurationRow>::as_select(),
                Option::<SelfHostedConfigurationRow>::as_select(),
                Option::<SystemConfigurationRow>::as_select(),
            ))
            .first(conn)
            .optional()?
    else {
        return Ok(None);
    };

    // Exactly one configuration is `Some` for a consistent registry — the one the
    // registration's `kind` names. A missing match is the cross-table invariant SQLite
    // can't enforce.
    let configuration = match registration.kind {
        AppKind::System => AppConfiguration::System(
            system
                .ok_or_else(|| missing_configuration(id, AppKind::System))?
                .into(),
        ),
        AppKind::Cloud => AppConfiguration::Cloud(
            cloud
                .ok_or_else(|| missing_configuration(id, AppKind::Cloud))?
                .into(),
        ),
        AppKind::SelfHosted => AppConfiguration::SelfHosted(
            self_hosted
                .ok_or_else(|| missing_configuration(id, AppKind::SelfHosted))?
                .into(),
        ),
    };
    Ok(Some((registration, configuration)))
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

/// Delete an app's registration by id; the configuration cascades
/// (`ON DELETE CASCADE`). Returns whether a registration row was removed (i.e. the
/// app existed).
fn delete_app_row(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppsError> {
    let removed = diesel::delete(app_registrations::table.find(id)).execute(conn)?;
    Ok(removed == 1)
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::super::test_support::{error_text, insert_upload};
    use crate::db::SqliteAppsStore;
    use crate::domain::{AppKind, AppsStore};

    /// `find_app` hydrates the whole app: the registration plus the kind
    /// configuration from its table, as a `(registration, configuration)` pair.
    #[test]
    fn find_app_reads_the_whole_app_per_kind() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let (registration, configuration) =
            store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(registration.name, "Growth Chart");
        assert_eq!(configuration.kind(), AppKind::Cloud);
        assert!(registration.is_smart());
        assert!(registration.requires_tunnel);
        let config = configuration.as_cloud().expect("cloud configuration");
        assert!(config.url.to_string().contains("growth-chart-app"));

        let (_registration, configuration) =
            store.find_app("patient-browser").unwrap().expect("seeded");
        let config = configuration
            .as_self_hosted()
            .expect("self-hosted configuration");
        assert_eq!(config.port, 8081);
        assert_eq!(config.content_folder, "patient-browser");
        assert_eq!(config.subdomain, "patient-browser");
        assert!(config.seeded);

        let (registration, configuration) = store.find_app("api-docs").unwrap().expect("seeded");
        assert_eq!(configuration.kind(), AppKind::System);
        assert_eq!(registration.name, "API Docs");
        assert_eq!(
            configuration.as_system().map(|c| c.url.to_string()),
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
    /// (the `AppUrlColumn` deserialize), not a silent unsafe value.
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
}

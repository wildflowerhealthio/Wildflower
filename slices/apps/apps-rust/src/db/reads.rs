//! The store's read side — typed diesel queries against the real
//! class-table-inheritance tables. The uniform catalogue read is a join-free
//! `SELECT * FROM app_registry ORDER BY position` decoded into
//! [`AppRegistration`]s; a detail read reads the registration then the one child
//! payload its `kind` names and composes the whole [`App`]. No `apps_view`, no
//! NULL-payload decode, no compiled-in system folding: every read is a typed query
//! against real tables, and the one CTI invariant SQLite can't enforce
//! (registration ⇒ its payload row exists) is checked at the single detail read as
//! a typed error.

use diesel::prelude::*;

use super::payloads::{CloudPayload, SelfHostedPayload, SystemPayload};
use super::schema::{app_registry, cloud_apps, self_hosted_apps, system_apps};
use crate::domain::{App, AppError, AppKind, AppRegistration, CloudApp, SelfHostedApp, SystemApp};

/// The uniform catalogue read against an arbitrary connection — shared by the
/// [`SqliteAppsStore`](super::SqliteAppsStore) `list_registrations` delegation and
/// the home-screen transaction (which calls it on its open transaction so the
/// post-renumber read stays in the same transaction). Join-free: the registration
/// carries everything the homescreen tile renders.
pub(super) fn list_registrations_on(
    conn: &mut SqliteConnection,
) -> Result<Vec<AppRegistration>, AppError> {
    Ok(app_registry::table
        .order(app_registry::position)
        .select(AppRegistration::as_select())
        .load(conn)?)
}

/// The registration ⇒ payload CTI invariant SQLite can't enforce across tables: a
/// registration says `kind` but the named child table has no row for its id. A
/// corrupt registry — surfaces as a typed [`AppError::Infrastructure`] (a logged
/// 500), never a partial [`App`].
fn missing_child(id: &str, kind: AppKind) -> AppError {
    AppError::infrastructure(
        "app_registry row has no matching child payload",
        format!("id={id} names kind {kind} but its {kind}_apps row is missing"),
    )
}

/// The single-app detail read against an arbitrary connection — the registration
/// plus the one child payload its `kind` names, what every store mutator calls **on
/// its own open transaction** to return the hydrated [`App`] it just wrote, and
/// what the per-kind detail routes read. `Ok(None)` when no registration has this
/// id; a registration whose child payload is missing is a corrupt registry →
/// [`missing_child`].
pub(super) fn find_app_on(conn: &mut SqliteConnection, id: &str) -> Result<Option<App>, AppError> {
    let Some(registration): Option<AppRegistration> = app_registry::table
        .find(id)
        .select(AppRegistration::as_select())
        .first(conn)
        .optional()?
    else {
        return Ok(None);
    };

    let app = match registration.kind {
        AppKind::System => {
            let payload: SystemPayload = system_apps::table
                .find(id)
                .select(SystemPayload::as_select())
                .first(conn)
                .optional()?
                .ok_or_else(|| missing_child(id, AppKind::System))?;
            App::System(SystemApp {
                registration,
                url: payload.url,
            })
        }
        AppKind::Cloud => {
            let payload: CloudPayload = cloud_apps::table
                .find(id)
                .select(CloudPayload::as_select())
                .first(conn)
                .optional()?
                .ok_or_else(|| missing_child(id, AppKind::Cloud))?;
            App::Cloud(CloudApp {
                registration,
                url: payload.url,
            })
        }
        AppKind::SelfHosted => {
            let payload: SelfHostedPayload = self_hosted_apps::table
                .find(id)
                .select(SelfHostedPayload::as_select())
                .first(conn)
                .optional()?
                .ok_or_else(|| missing_child(id, AppKind::SelfHosted))?;
            App::SelfHosted(self_hosted_from_parts(registration, payload))
        }
    };
    Ok(Some(app))
}

/// Every self-hosted app, whole, in display order — a typed inner join
/// `self_hosted_apps ⋈ app_registry`. The host materializes this once at setup to
/// bind a loopback listener per app; ordering by position keeps the bind order
/// stable.
pub(super) fn list_self_hosted_apps_on(conn: &mut SqliteConnection) -> Result<Vec<App>, AppError> {
    let rows: Vec<(SelfHostedPayload, AppRegistration)> = self_hosted_apps::table
        .inner_join(app_registry::table)
        .order(app_registry::position)
        .select((SelfHostedPayload::as_select(), AppRegistration::as_select()))
        .load(conn)?;
    Ok(rows
        .into_iter()
        .map(|(payload, registration)| {
            App::SelfHosted(self_hosted_from_parts(registration, payload))
        })
        .collect())
}

/// Compose a [`SelfHostedApp`] from its registration + payload — the one place the
/// self-hosted payload columns map onto the domain type, shared by the detail read
/// and the host-listener list.
fn self_hosted_from_parts(
    registration: AppRegistration,
    payload: SelfHostedPayload,
) -> SelfHostedApp {
    SelfHostedApp {
        registration,
        port: payload.port,
        content_folder: payload.content_folder,
        subdomain: payload.subdomain,
        seeded: payload.seeded,
        launch_path: payload.launch_path,
    }
}

/// Whether any app already holds this id — checked against `app_registry`, the
/// parent PK and so the global id space across every kind.
pub(super) fn id_taken(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppError> {
    let taken = diesel::select(diesel::dsl::exists(
        app_registry::table.filter(app_registry::id.eq(id)),
    ))
    .get_result::<bool>(conn)?;
    Ok(taken)
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry).
pub(super) fn next_position(conn: &mut SqliteConnection) -> Result<i64, AppError> {
    let max: Option<i64> = app_registry::table
        .select(diesel::dsl::max(app_registry::position))
        .first(conn)?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Delete an app's registration by id; the child payload cascades
/// (`ON DELETE CASCADE`). Returns whether a registration row was removed (i.e. the
/// app existed).
pub(super) fn delete_app_row(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppError> {
    let removed = diesel::delete(app_registry::table.find(id)).execute(conn)?;
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

    /// `list_registrations` reports `smart` (cloud SMART-client rows), `local_only`
    /// (the loopback ones), `requires_tunnel` (cloud), and the kind per row.
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
            assert!(reg.smart(), "{cloud} must be smart");
            assert_eq!(reg.kind, AppKind::Cloud);
            assert!(reg.requires_tunnel, "{cloud} requires the tunnel");
        }
        for local in ["patient-browser", "api-view", "api-docs"] {
            let reg = by_id(local);
            assert!(reg.local_only, "{local} must be local-only");
            assert!(!reg.smart(), "{local} must not be smart");
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
        let pb = apps
            .iter()
            .find(|a| a.id() == "patient-browser")
            .expect("patient-browser is seeded");
        assert_eq!(pb.name(), "Patient Browser");
        let payload = pb.as_self_hosted().expect("self-hosted payload");
        assert_eq!(payload.port, 8081);
        assert_eq!(payload.content_folder, "patient-browser");
        assert_eq!(payload.subdomain, "patient-browser");
        assert!(payload.seeded);
        assert!(
            apps.iter().all(|a| a.as_self_hosted().is_some()),
            "only self-hosted apps may appear",
        );
    }

    /// `find_app` hydrates the whole app: the registration plus the kind payload
    /// from the child table.
    #[test]
    fn find_app_reads_the_whole_app_per_kind() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let cloud = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(cloud.name(), "Growth Chart");
        assert_eq!(cloud.kind(), AppKind::Cloud);
        assert!(cloud.smart());
        assert!(cloud.registration().requires_tunnel);
        let payload = cloud.as_cloud().expect("cloud payload");
        assert!(payload.url.to_string().contains("growth-chart-app"));

        let self_hosted = store.find_app("patient-browser").unwrap().expect("seeded");
        let payload = self_hosted.as_self_hosted().expect("self-hosted payload");
        assert_eq!(payload.port, 8081);
        assert_eq!(payload.content_folder, "patient-browser");
        assert_eq!(payload.subdomain, "patient-browser");
        assert!(payload.seeded);

        let system = store.find_app("api-docs").unwrap().expect("seeded");
        assert_eq!(system.kind(), AppKind::System);
        assert_eq!(system.name(), "API Docs");
        assert_eq!(
            system.as_system_url(),
            Some("{origin}/docs".to_owned()),
            "the system payload carries the compiled-shell launch template",
        );

        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    /// A registration whose child payload row is gone (raw SQL tampering) is a
    /// typed read error, not a partial `App` — pins the CTI invariant.
    #[test]
    fn missing_child_payload_is_a_typed_read_error() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        diesel::sql_query("DELETE FROM cloud_apps WHERE id = 'growth-chart'")
            .execute(&mut conn)
            .unwrap();
        drop(conn);
        let error = store
            .find_app("growth-chart")
            .expect_err("a registration with no child payload must fail the read");
        assert!(
            error_text(&error).contains("no matching child payload"),
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
            "UPDATE cloud_apps SET url = 'http://evil.example.com' WHERE id = 'growth-chart'",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        assert!(store.find_app("growth-chart").is_err());
    }

    impl App {
        /// Test helper — the system payload url as a string, `None` for other kinds.
        fn as_system_url(&self) -> Option<String> {
            match self {
                App::System(app) => Some(app.url.to_string()),
                _ => None,
            }
        }
    }

    fn error_text(error: &crate::domain::AppError) -> String {
        match error {
            crate::domain::AppError::Infrastructure { context, source } => {
                format!("{context}: {source}")
            }
            other => format!("{other:?}"),
        }
    }
}

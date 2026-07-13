//! The store's read side: the cross-kind `apps_view` (a `UNION ALL` of the
//! concrete tables joined to `home_screen`) decoded into whole [`App`]s, folded
//! together with the compiled-in system apps by `home_screen` position. Every
//! read (catalogue, single row, host listener list) goes through the same view
//! projection + the same decoder, so cloud / self-hosted reads can't drift; the
//! decoder synthesizes the tableless system apps from `home_screen` rows whose id
//! isn't a concrete row.

use std::collections::HashMap;

use diesel::prelude::*;
use diesel::sql_types::{BigInt, Bool, Integer, Nullable, Text};

use super::schema::{home_screen, self_hosted_apps};
use crate::domain::{system_app, App, AppError, AppUrl, CloudApp, SelfHostedApp};

/// The explicit `apps_view` column list — the shared columns, the `provenance`
/// kind tag, and each kind's NULLable payload columns. Named identically to the
/// [`AppViewRow`] fields so `QueryableByName` maps them by name.
const VIEW_COLUMNS: &str = "id, name, subtitle, local_only, client_id, position, enabled, \
     provenance, url, requires_tunnel, port, content_folder, subdomain, seeded, launch_path";

/// One decoded `apps_view` row — the shared columns plus the NULLable per-kind
/// payload columns, read as raw scalars and turned into a whole [`App`] by
/// [`app_from_view_row`]. System apps are not in the view (they have no table);
/// the catalogue reads fold them in separately.
#[derive(QueryableByName)]
struct AppViewRow {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Nullable<Text>)]
    subtitle: Option<String>,
    #[diesel(sql_type = Bool)]
    local_only: bool,
    #[diesel(sql_type = Nullable<Text>)]
    client_id: Option<String>,
    #[diesel(sql_type = BigInt)]
    position: i64,
    #[diesel(sql_type = Bool)]
    enabled: bool,
    #[diesel(sql_type = Text)]
    provenance: String,
    #[diesel(sql_type = Nullable<Text>)]
    url: Option<String>,
    #[diesel(sql_type = Nullable<Bool>)]
    requires_tunnel: Option<bool>,
    #[diesel(sql_type = Nullable<Integer>)]
    port: Option<i32>,
    #[diesel(sql_type = Nullable<Text>)]
    content_folder: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    subdomain: Option<String>,
    #[diesel(sql_type = Nullable<Bool>)]
    seeded: Option<bool>,
    #[diesel(sql_type = Nullable<Text>)]
    launch_path: Option<String>,
}

/// A required payload column was NULL for a row whose `provenance` needs it — a
/// corrupt view row (e.g. a cloud row with no `url`). Surfaces as a typed
/// [`AppError::Infrastructure`] (a logged 500), never a partial [`App`].
fn missing(column: &str, provenance: &str) -> AppError {
    AppError::infrastructure(
        "apps_view row missing a required payload column",
        format!("{column} is NULL for a {provenance} row"),
    )
}

/// Decode one [`AppViewRow`] into a whole [`App`], dispatching on the `provenance`
/// kind tag and parsing the stored scalars into their domain types (the cloud
/// `url` through [`AppUrl`], the `port` narrowed to `u16`). Only `cloud` /
/// `self-hosted` reach here — system apps have no view row.
fn app_from_view_row(row: AppViewRow) -> Result<App, AppError> {
    match row.provenance.as_str() {
        "cloud" => {
            let url = row
                .url
                .ok_or_else(|| missing("url", "cloud"))?
                .parse::<AppUrl>()
                .map_err(|e| {
                    AppError::infrastructure("apps_view stored cloud url failed to parse", e)
                })?;
            let requires_tunnel = row
                .requires_tunnel
                .ok_or_else(|| missing("requires_tunnel", "cloud"))?;
            Ok(App::Cloud {
                position: row.position,
                enabled: row.enabled,
                app: CloudApp {
                    id: row.id,
                    name: row.name,
                    subtitle: row.subtitle,
                    local_only: row.local_only,
                    client_id: row.client_id,
                    url,
                    requires_tunnel,
                },
            })
        }
        "self-hosted" => {
            let raw_port = row.port.ok_or_else(|| missing("port", "self-hosted"))?;
            let port = u16::try_from(raw_port).map_err(|e| {
                AppError::infrastructure("apps_view stored port is out of range", e)
            })?;
            Ok(App::SelfHosted {
                position: row.position,
                enabled: row.enabled,
                app: SelfHostedApp {
                    id: row.id,
                    name: row.name,
                    subtitle: row.subtitle,
                    local_only: row.local_only,
                    client_id: row.client_id,
                    port,
                    content_folder: row
                        .content_folder
                        .ok_or_else(|| missing("content_folder", "self-hosted"))?,
                    subdomain: row
                        .subdomain
                        .ok_or_else(|| missing("subdomain", "self-hosted"))?,
                    seeded: row.seeded.ok_or_else(|| missing("seeded", "self-hosted"))?,
                    launch_path: row.launch_path,
                },
            })
        }
        other => Err(AppError::infrastructure(
            "apps_view carried an unknown provenance",
            other.to_owned(),
        )),
    }
}

/// The catalogue read against an arbitrary connection — shared by the
/// [`SqliteAppsStore`](super::SqliteAppsStore) `list_apps` delegation and the
/// home-screen transaction (which calls it on its open transaction so the
/// post-renumber read stays in the same transaction).
///
/// Reads the `apps_view` (cloud + self-hosted) into a by-id map, then walks the
/// `home_screen` rows in `position` order: each id resolves to its view app or, if
/// it isn't a concrete row, to a compiled-in [`system_app`] entry. A `home_screen`
/// row that resolves to neither is a corrupt registry → typed [`AppError`].
pub(super) fn list_apps_on(conn: &mut SqliteConnection) -> Result<Vec<App>, AppError> {
    let view_rows: Vec<AppViewRow> =
        diesel::sql_query(format!("SELECT {VIEW_COLUMNS} FROM apps_view")).load(conn)?;
    let mut by_id: HashMap<String, App> = HashMap::with_capacity(view_rows.len());
    for row in view_rows {
        let app = app_from_view_row(row)?;
        by_id.insert(app.id().to_owned(), app);
    }

    let placements: Vec<(String, i64, bool)> = home_screen::table
        .order(home_screen::position)
        .select((
            home_screen::app_id,
            home_screen::position,
            home_screen::enabled,
        ))
        .load(conn)?;

    let mut apps = Vec::with_capacity(placements.len());
    for (app_id, position, enabled) in placements {
        if let Some(app) = by_id.remove(&app_id) {
            apps.push(app);
        } else if let Some(source) = system_app::find(&app_id) {
            apps.push(App::System {
                position,
                enabled,
                app: *source,
            });
        } else {
            return Err(AppError::infrastructure(
                "home_screen row resolves to no cloud, self-hosted, or system app",
                app_id,
            ));
        }
    }
    Ok(apps)
}

/// The single-app read against an arbitrary connection — what every store mutator
/// calls **on its own open transaction** to return the hydrated [`App`] it just
/// wrote, so a write's response can never drift from what a subsequent read would
/// produce. A `home_screen` row whose id is neither a concrete row nor a
/// compiled-in system app is a corrupt registry → typed [`AppError`].
pub(super) fn find_app_on(conn: &mut SqliteConnection, id: &str) -> Result<Option<App>, AppError> {
    let view_row: Option<AppViewRow> =
        diesel::sql_query(format!("SELECT {VIEW_COLUMNS} FROM apps_view WHERE id = ?"))
            .bind::<Text, _>(id)
            .get_result(conn)
            .optional()?;
    if let Some(row) = view_row {
        return Ok(Some(app_from_view_row(row)?));
    }

    let placement: Option<(i64, bool)> = home_screen::table
        .find(id)
        .select((home_screen::position, home_screen::enabled))
        .first(conn)
        .optional()?;
    match placement {
        Some((position, enabled)) => match system_app::find(id) {
            Some(source) => Ok(Some(App::System {
                position,
                enabled,
                app: *source,
            })),
            None => Err(AppError::infrastructure(
                "home_screen row resolves to no app kind",
                id.to_owned(),
            )),
        },
        None => Ok(None),
    }
}

/// Every self-hosted app, whole, in display order — the query body the
/// [`SqliteAppsStore`](super::SqliteAppsStore) `list_self_hosted_apps` delegation
/// runs on a checked-out connection. The host materializes this once at setup to
/// bind a loopback listener per app; the seeded self-hosted set is small, and
/// ordering by position keeps the host's bind order stable.
pub(super) fn list_self_hosted_apps_on(conn: &mut SqliteConnection) -> Result<Vec<App>, AppError> {
    let rows: Vec<AppViewRow> = diesel::sql_query(format!(
        "SELECT {VIEW_COLUMNS} FROM apps_view WHERE provenance = 'self-hosted' ORDER BY position"
    ))
    .load(conn)?;
    rows.into_iter().map(app_from_view_row).collect()
}

/// Insert a `home_screen` row (used by the create paths). Split out so the create
/// mutators share one place that stamps the ordering row.
pub(super) fn insert_home_screen_row(
    conn: &mut SqliteConnection,
    app_id: &str,
    position: i64,
) -> Result<(), AppError> {
    diesel::insert_into(home_screen::table)
        .values((
            home_screen::app_id.eq(app_id),
            home_screen::position.eq(position),
            home_screen::enabled.eq(true),
        ))
        .execute(conn)?;
    Ok(())
}

/// Whether any app already holds this id — checked against `home_screen`, which
/// carries exactly one row per app of every kind (so it is the global id space).
pub(super) fn id_taken(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppError> {
    let taken = diesel::select(diesel::dsl::exists(
        home_screen::table.filter(home_screen::app_id.eq(id)),
    ))
    .get_result::<bool>(conn)?;
    Ok(taken)
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry).
pub(super) fn next_position(conn: &mut SqliteConnection) -> Result<i64, AppError> {
    let max: Option<i64> = home_screen::table
        .select(diesel::dsl::max(home_screen::position))
        .first(conn)?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Delete an app's `home_screen` row plus its concrete row (whichever table holds
/// it). Returns whether a `home_screen` row was removed (i.e. the app existed).
pub(super) fn delete_app_rows(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppError> {
    use super::schema::cloud_apps;

    let removed = diesel::delete(home_screen::table.find(id)).execute(conn)?;
    diesel::delete(cloud_apps::table.find(id)).execute(conn)?;
    diesel::delete(self_hosted_apps::table.find(id)).execute(conn)?;
    Ok(removed == 1)
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use crate::db::SqliteAppsStore;
    use crate::domain::system_app::SYSTEM_APPS;
    // The port trait is in scope so the concrete adapter's `list_apps` / `find_app`
    // / `list_self_hosted_apps` methods resolve.
    use crate::domain::{App, AppsStore, Provenance};

    /// The migration seeds the full default set: 6 apps in display order with the
    /// right provenance.
    #[test]
    fn migration_seeds_the_default_registry() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let apps = store.list_apps().unwrap();
        let ids: Vec<&str> = apps.iter().map(App::id).collect();
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

    /// `list_apps` reports `smart` only for the cloud (SMART-client) rows and
    /// `local_only` for the loopback ones, with the cloud payloads carrying their
    /// tunnel requirement.
    #[test]
    fn list_apps_reports_smart_and_local_only_per_row() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let apps = store.list_apps().unwrap();
        let by_id = |id: &str| apps.iter().find(|a| a.id() == id).expect("seeded row");

        for cloud in ["growth-chart", "medication-viewer", "precise-hbr"] {
            let app = by_id(cloud);
            assert!(app.smart(), "{cloud} must be smart");
            assert_eq!(app.provenance(), Provenance::Cloud);
            assert!(
                app.as_cloud().expect("cloud payload").requires_tunnel,
                "{cloud} requires the tunnel",
            );
        }
        for local in ["patient-browser", "api-view", "api-docs"] {
            let app = by_id(local);
            assert!(app.local_only(), "{local} must be local-only");
            assert!(!app.smart(), "{local} must not be smart");
            assert!(
                app.as_cloud().is_none(),
                "{local} must not carry a cloud payload",
            );
        }
        assert_eq!(
            by_id("patient-browser").provenance(),
            Provenance::SelfHosted
        );
        assert_eq!(by_id("api-view").provenance(), Provenance::System);
        assert_eq!(by_id("api-docs").provenance(), Provenance::System);
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
        assert!(
            payload.seeded,
            "the migration-seeded row must be flagged seeded"
        );
        assert!(
            apps.iter().all(|a| a.as_self_hosted().is_some()),
            "only self-hosted apps may appear",
        );
    }

    /// Every seeded `system` `home_screen` id resolves to a compiled-in
    /// [`SYSTEM_APPS`] source, and the synthesized catalogue entry carries the
    /// compiled-in name / subtitle / local_only (system apps store none of that).
    #[test]
    fn system_home_screen_rows_resolve_to_the_compiled_in_source() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let apps = store.list_apps().unwrap();
        let system_rows: Vec<&App> = apps
            .iter()
            .filter(|a| a.provenance() == Provenance::System)
            .collect();
        assert_eq!(
            system_rows.len(),
            SYSTEM_APPS.len(),
            "seeded system home_screen rows and the SYSTEM_APPS source must be 1:1",
        );
        for source in SYSTEM_APPS {
            let row = system_rows
                .iter()
                .find(|a| a.id() == source.id)
                .unwrap_or_else(|| panic!("no seeded system row for {}", source.id));
            assert_eq!(row.name(), source.name, "{} name", source.id);
            assert_eq!(row.subtitle(), source.subtitle, "{} subtitle", source.id);
            assert_eq!(
                row.local_only(),
                source.local_only,
                "{} local_only",
                source.id
            );
        }
    }

    /// `find_app` hydrates the whole app: shared fields plus the kind payload from
    /// the concrete table (or the compiled-in source for system apps).
    #[test]
    fn find_app_reads_the_whole_app_per_kind() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let cloud = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(cloud.name(), "Growth Chart");
        assert_eq!(cloud.provenance(), Provenance::Cloud);
        assert!(cloud.smart());
        let payload = cloud.as_cloud().expect("cloud payload");
        assert_eq!(payload.client_id.as_deref(), Some("growth_chart"));
        assert!(payload.requires_tunnel);
        assert!(payload.url.to_string().contains("growth-chart-app"));

        let self_hosted = store.find_app("patient-browser").unwrap().expect("seeded");
        let payload = self_hosted.as_self_hosted().expect("self-hosted payload");
        assert_eq!(payload.port, 8081);
        assert_eq!(payload.content_folder, "patient-browser");
        assert_eq!(payload.subdomain, "patient-browser");
        assert!(payload.seeded);

        let system = store.find_app("api-docs").unwrap().expect("seeded");
        assert_eq!(system.provenance(), Provenance::System);
        assert_eq!(system.name(), "API Docs");

        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    /// A `home_screen` row whose concrete row is gone (raw SQL tampering) and
    /// which isn't a compiled-in system id is a typed read error, not a partial
    /// `App` — pins the corrupt-registry posture.
    #[test]
    fn dangling_home_screen_row_is_a_typed_read_error() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        diesel::sql_query("DELETE FROM cloud_apps WHERE id = 'growth-chart'")
            .execute(&mut conn)
            .unwrap();
        drop(conn);
        let error = store
            .find_app("growth-chart")
            .expect_err("a home_screen row with no concrete or system source must fail the read");
        assert!(
            error_text(&error).contains("no app kind"),
            "error should name the invariant: {error:?}",
        );
    }

    /// A stored cloud `url` that no longer parses surfaces as a typed read error
    /// (via the view decoder), not a silent unsafe value.
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

    fn error_text(error: &crate::domain::AppError) -> String {
        match error {
            crate::domain::AppError::Infrastructure { context, source } => {
                format!("{context}: {source}")
            }
            other => format!("{other:?}"),
        }
    }
}

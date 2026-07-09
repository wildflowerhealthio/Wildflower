//! The store's read side: one JOIN projection decoding a whole [`App`] —
//! parent row plus the kind payload — so every read (catalogue, single row,
//! host listener list) goes through the same columns and the same decoder and
//! can't drift.

use persistence_rust::DbResult;
use rusqlite::types::{FromSqlError, Type};
use rusqlite::{params, OptionalExtension};

use super::AppsStore;
use crate::domain::{App, AppKind, CloudApp, Provenance, SelfHostedApp};

/// The one SELECT every app read uses: the parent columns plus both LEFT-JOINed
/// children. No computed columns — `smart` / `removable` are derived in Rust
/// ([`App::smart`] / [`App::removable`]); [`app_from_row`] picks the child
/// columns its provenance needs.
const APP_COLUMNS: &str = "a.id, a.name, a.subtitle, a.enabled, a.position, a.local_only, \
     a.client_id, a.provenance, \
     c.url, c.requires_tunnel, \
     s.port, s.content_folder, s.subdomain, s.seeded, s.launch_path \
     FROM apps a \
     LEFT JOIN cloud_apps c ON c.id = a.id \
     LEFT JOIN self_hosted_apps s ON s.id = a.id";

/// Decode one [`APP_COLUMNS`] row into a whole [`App`], dispatching the kind
/// payload on the stored `provenance`.
///
/// The single enforcement point of parent-implies-child: a `cloud` /
/// `self-hosted` parent whose child row is missing reads `NULL` into a
/// non-nullable payload field and surfaces as a typed
/// [`rusqlite::Error::InvalidColumnType`] (a logged 500 at the handler seam),
/// never a partial `App`. See `docs/Apps/Store and Install Explanation.md`.
pub(super) fn app_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<App> {
    let kind = match row.get::<_, Provenance>("provenance")? {
        Provenance::System => AppKind::System,
        Provenance::Cloud => AppKind::Cloud(CloudApp {
            url: get_child(row, "url")?,
            requires_tunnel: get_child(row, "requires_tunnel")?,
        }),
        Provenance::SelfHosted => AppKind::SelfHosted(SelfHostedApp {
            port: get_child(row, "port")?,
            content_folder: get_child(row, "content_folder")?,
            subdomain: get_child(row, "subdomain")?,
            seeded: get_child(row, "seeded")?,
            // Genuinely nullable — an absent launch path is a root-served app.
            launch_path: row.get("launch_path")?,
        }),
    };
    Ok(App {
        id: row.get("id")?,
        name: row.get("name")?,
        subtitle: row.get("subtitle")?,
        enabled: row.get("enabled")?,
        position: row.get("position")?,
        local_only: row.get("local_only")?,
        client_id: row.get("client_id")?,
        kind,
    })
}

/// Read a required child column, mapping a `NULL` (the LEFT JOIN found no child
/// row) to an [`rusqlite::Error::InvalidColumnType`] that names the column —
/// the typed "parent has no child row" error [`app_from_row`] promises.
fn get_child<T: rusqlite::types::FromSql>(
    row: &rusqlite::Row<'_>,
    column: &str,
) -> rusqlite::Result<T> {
    row.get(column).map_err(|error| match error {
        rusqlite::Error::InvalidColumnType(index, name, Type::Null) => {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Null,
                Box::new(FromSqlError::Other(
                    format!("child row missing: {name} is NULL for this provenance").into(),
                )),
            )
        }
        other => other,
    })
}

/// The catalogue read against an arbitrary connection — shared by
/// [`AppsStore::list_apps`] (which locks then calls this) and the home-screen
/// transaction (which calls it on its open transaction so the post-renumber
/// read stays inside the same transaction).
pub(super) fn list_apps_on(conn: &rusqlite::Connection) -> DbResult<Vec<App>> {
    let mut stmt = conn.prepare(&format!("SELECT {APP_COLUMNS} ORDER BY a.position"))?;
    let rows = stmt.query_map([], app_from_row)?;
    rows.collect()
}

/// The single-app read against an arbitrary connection — what every store
/// mutator calls **on its own open transaction** to return the hydrated
/// [`App`] it just wrote, so a write's response can never drift from what a
/// subsequent read would produce.
pub(super) fn find_app_on(conn: &rusqlite::Connection, id: &str) -> DbResult<Option<App>> {
    conn.query_row(
        &format!("SELECT {APP_COLUMNS} WHERE a.id = ?1"),
        params![id],
        app_from_row,
    )
    .optional()
}

impl AppsStore {
    /// The `GET /apps` catalogue: every app, whole, ordered by `position`.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_apps(&self) -> DbResult<Vec<App>> {
        let conn = self.conn().lock();
        list_apps_on(&conn)
    }

    /// A single whole app by id, `None` when absent. Backs the launch dispatch
    /// (the kind payload carries the launch data) and the admin existence /
    /// editability checks.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_app(&self, id: &str) -> DbResult<Option<App>> {
        let conn = self.conn().lock();
        find_app_on(&conn, id)
    }

    /// Every self-hosted app, whole, in seed/insertion order. The host
    /// materializes this once at setup to bind a loopback listener per app.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_self_hosted_apps(&self) -> DbResult<Vec<App>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {APP_COLUMNS} WHERE a.provenance = 'self-hosted' ORDER BY s.rowid"
        ))?;
        let rows = stmt.query_map([], app_from_row)?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::db::AppsStore;
    use crate::domain::system_app::SYSTEM_APPS;
    use crate::domain::{App, AppKind, Provenance};

    /// Migration 004 seeds the full default set: 6 parent rows in display order
    /// with the right provenance, plus the matching child rows.
    #[test]
    fn migration_seeds_the_default_registry() {
        let store = AppsStore::open_in_memory().unwrap();
        let apps = store.list_apps().unwrap();
        let ids: Vec<&str> = apps.iter().map(|a| a.id.as_str()).collect();
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
    /// `local_only` for the loopback ones, with the cloud payloads carrying
    /// their tunnel requirement.
    #[test]
    fn list_apps_reports_smart_and_local_only_per_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let apps = store.list_apps().unwrap();
        let by_id = |id: &str| apps.iter().find(|a| a.id == id).expect("seeded row");

        // The 3 cloud apps carry a gatekeeper client_id → smart.
        for cloud in ["growth-chart", "medication-viewer", "precise-hbr"] {
            let app = by_id(cloud);
            assert!(app.smart(), "{cloud} must be smart");
            assert_eq!(app.provenance(), Provenance::Cloud);
            assert!(
                app.as_cloud().expect("cloud payload").requires_tunnel,
                "{cloud} requires the tunnel",
            );
        }
        // The loopback apps are local-only and not smart.
        for local in ["patient-browser", "api-view", "api-docs"] {
            let app = by_id(local);
            assert!(app.local_only, "{local} must be local-only");
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
        let store = AppsStore::open_in_memory().unwrap();
        let apps = store.list_self_hosted_apps().unwrap();
        let pb = apps
            .iter()
            .find(|a| a.id == "patient-browser")
            .expect("patient-browser is seeded");
        assert_eq!(pb.name, "Patient Browser");
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

    /// The compiled-in [`SYSTEM_APPS`] source list must agree with the seeded
    /// `provenance = 'system'` parent rows on id / name / subtitle / local_only.
    #[test]
    fn system_app_source_matches_seeded_system_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        let apps = store.list_apps().unwrap();
        let system_rows: Vec<&App> = apps
            .iter()
            .filter(|a| a.provenance() == Provenance::System)
            .collect();
        assert_eq!(
            system_rows.len(),
            SYSTEM_APPS.len(),
            "seeded system rows and the SYSTEM_APPS source must be 1:1",
        );
        for source in SYSTEM_APPS {
            let row = system_rows
                .iter()
                .find(|a| a.id == source.id)
                .unwrap_or_else(|| panic!("no seeded system row for {}", source.id));
            assert_eq!(row.name, source.name, "{} name", source.id);
            assert_eq!(
                row.subtitle.as_deref(),
                source.subtitle,
                "{} subtitle",
                source.id,
            );
            assert_eq!(
                row.local_only, source.local_only,
                "{} local_only",
                source.id,
            );
        }
    }

    /// `find_app` hydrates the whole app: parent fields plus the kind payload
    /// decoded from the child table (or fieldless for system apps).
    #[test]
    fn find_app_reads_the_whole_app_per_kind() {
        let store = AppsStore::open_in_memory().unwrap();

        let cloud = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(cloud.name, "Growth Chart");
        assert_eq!(cloud.provenance(), Provenance::Cloud);
        assert_eq!(cloud.client_id.as_deref(), Some("growth_chart"));
        assert!(cloud.smart());
        let payload = cloud.as_cloud().expect("cloud payload");
        assert!(payload.requires_tunnel);
        assert!(payload.url.to_string().contains("growth-chart-app"));

        let self_hosted = store.find_app("patient-browser").unwrap().expect("seeded");
        let payload = self_hosted.as_self_hosted().expect("self-hosted payload");
        assert_eq!(payload.port, 8081);
        assert_eq!(payload.content_folder, "patient-browser");
        assert_eq!(payload.subdomain, "patient-browser");
        assert!(payload.seeded);

        let system = store.find_app("api-docs").unwrap().expect("seeded");
        assert_eq!(system.kind, AppKind::System);

        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    /// A `cloud` parent whose child row is gone (raw SQL tampering) is a typed
    /// read error, not a partial `App` — pins the parent-implies-child posture
    /// that used to be re-checked in the launch handler.
    #[test]
    fn missing_child_row_is_a_typed_read_error() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .conn()
            .lock()
            .execute("DELETE FROM cloud_apps WHERE id = 'growth-chart'", [])
            .unwrap();
        let error = store
            .find_app("growth-chart")
            .expect_err("a cloud parent with no child must fail the read");
        assert!(
            error.to_string().contains("child row missing"),
            "error should name the invariant: {error}",
        );
    }

    /// A stored cloud `url` that no longer parses surfaces as a typed read
    /// error (via `AppUrl`'s `FromSql`), not a silent unsafe value.
    #[test]
    fn find_app_rejects_an_unparseable_stored_url() {
        let store = AppsStore::open_in_memory().unwrap();
        store
            .conn()
            .lock()
            .execute(
                "UPDATE cloud_apps SET url = 'http://evil.example.com' WHERE id = 'growth-chart'",
                [],
            )
            .unwrap();
        assert!(store.find_app("growth-chart").is_err());
    }
}

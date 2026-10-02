//! The `SqliteAppsStore` adapter — the `SQLite` implementation of the
//! [`AppsStore`](crate::domain::AppsStore) port. Holds the app-wide r2d2 pool of
//! Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared
//! database file, applies the embedded apps migrations once on construction, and
//! implements the port by delegating to the per-kind query bodies in
//! [`crate::db::app_registration`] / [`crate::db::cloud_apps`] /
//! [`crate::db::all_kinds_apps`]. Mirrors
//! `collector-rust`'s `SqliteRemotesStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::db::{all_kinds_apps, app_registration, cloud_apps};
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration,
    CloudInsertError,
};

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`persistence_rust::run_diesel_migrations`], so
/// apps' `0001` and another diesel slice's `0001` never collide.
const MIGRATION_NAMESPACE: &str = "apps";

/// The apps migrations, embedded from the crate's `migrations/` tree at compile
/// time (diesel layout: `<version>_<name>/up.sql` + `down.sql`). Applied once per
/// database in [`SqliteAppsStore::new`] via
/// [`persistence_rust::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`] (see
/// that runner for why the stock diesel harness can't be used across slices).
/// Migration `0001` builds the `app_registrations` table and its three
/// configuration tables; `0002` seeds the default registry (kept separate so the
/// schema and the shipped data version independently); `0003` and `0004` each
/// append one shipped first-party SMART app — one migration per app, so which
/// apps ship versions independently of both the schema and the baseline set;
/// `0005` renames those two to `medications-app` / `web-trace-app` and turns them
/// into CLOUD rows served from the published GitHub Pages site (adding the
/// server-docs console); `0006` appends the Importer as a third first-party CLOUD
/// app served from the same site; `0007` appends the OHIF imaging viewer, a
/// fourth CLOUD app from that site, and `0008` moves its launch onto the FHIR
/// Viewer route; `0009` repairs the Medications and Web Trace rows on any install
/// `0005` left short of cloud; `0010` appends Lifting, another first-party
/// CLOUD app from the same site; and `0011` deletes every self-hosted
/// registration, drops `self_hosted_app_configurations`, and narrows the `kind`
/// CHECK to system + cloud. Because each migration runs only once per
/// database, a user-deleted seed stays deleted across upgrades. The debug-only
/// `…-dev` cloud rows are deliberately NOT migrations — see
/// `apps-rust/src/dev_seed.rs`.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`AppsStore`] port — serves the registrations plus
/// the cloud + system configurations. Cheap to clone (the pool is an `Arc`
/// inside), so it drops straight into the axum state.
#[derive(Clone)]
pub struct SqliteAppsStore {
    // The host-owned app-wide r2d2 pool (`persistence_rust::open_pool`) onto the
    // shared database file. Each query checks a connection out (diesel's API is
    // `&mut`); the pool is an `Arc` inside, so the store is cheap to clone into
    // the axum state. See docs/Persistence/Shared Diesel Pool Explanation.md for
    // how this pool coexists with the rusqlite connection on one file.
    pool: DieselPool,
}

impl SqliteAppsStore {
    /// Wrap the host-owned connection `pool` and apply pending apps migrations
    /// once, on a single checked-out connection. The host builds the app-wide pool
    /// (via `persistence_rust::open_pool`) on the same file its rusqlite
    /// connection opens for the other slices; both coexist (SQLite permits
    /// multiple connections per file).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out or a migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run apps migrations")?;
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .context("failed to apply apps migrations")?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call is
    /// an independent, freshly-migrated database (see
    /// `persistence_rust::open_in_memory_pool`).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(persistence_rust::open_in_memory_pool()?)
    }

    /// Check a connection out of the pool, mapping an exhausted-pool failure to an
    /// opaque [`AppsError::Infrastructure`]. Each per-kind query body runs on one of
    /// these, checked out per call — diesel's connection API is `&mut`, so the store
    /// hands out a fresh connection rather than sharing one.
    fn connection(&self) -> Result<PooledDieselConnection, AppsError> {
        self.pool
            .get()
            .map_err(|e| AppsError::infrastructure("failed to check out a connection", e))
    }

    /// The pool, for tests that tamper with rows via raw SQL.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The `SQLite` implementation of the port: each method checks a connection out
/// of the pool (via [`connection`](Self::connection)) and hands it to the matching
/// per-kind query body ([`crate::db::app_registration`] / [`crate::db::cloud_apps`] /
/// [`crate::db::all_kinds_apps`]). The bodies live
/// there so this file stays the migration + pool handle, and the query SQL stays
/// next to the `table!` + row types it maps. Every method returns the port's PRIMITIVE shape
/// — absence as `None`, delete outcome as `bool`, a cloud insert that wrote nothing
/// as the granular typed [`CloudInsertError`] — leaving the semantic verdicts to
/// the [`capabilities`](crate::domain::capabilities).
impl AppsStore for SqliteAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        let mut conn = self.connection()?;
        app_registration::list_registrations_on(&mut conn)
    }

    fn find_app(&self, id: &str) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError> {
        let mut conn = self.connection()?;
        all_kinds_apps::find_app_on(&mut conn, id)
    }

    fn insert_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError> {
        cloud_apps::insert_cloud_app(&mut self.connection()?, registration, config)
    }

    fn replace_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError> {
        cloud_apps::replace_cloud_app(&mut self.connection()?, registration, config)
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
        all_kinds_apps::delete_app(&mut self.connection()?, id)
    }

    fn replace_placements(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppsError> {
        app_registration::replace_placements(&mut self.connection()?, entries)
    }
}

#[cfg(test)]
mod tests {
    use diesel::migration::{Migration, MigrationSource, MigrationVersion};
    use diesel::prelude::*;
    use diesel::sql_types::{BigInt, Integer, Text};
    use diesel::sqlite::{Sqlite, SqliteConnection};
    use diesel::{sql_query, QueryableByName};

    use super::*;
    use crate::db::app_registration::app_registrations;

    /// Running the migrations twice is a no-op the second time (the namespaced
    /// runner skips the already-applied `0001`), and the seeded default registry
    /// lands exactly once — so opening an existing database never re-seeds or
    /// errors.
    #[test]
    fn migrations_are_idempotent_and_seed_the_default_registry_once() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .unwrap();
        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .unwrap();
        let row_count: i64 = app_registrations::table
            .count()
            .get_result(&mut conn)
            .expect("app_registrations must exist after migrate");
        assert_eq!(row_count, 11, "exactly the eleven seeded default apps");
    }

    /// The `app_registrations` primary key gives global id uniqueness across kinds
    /// — a second registration with a seeded id is rejected by the PK, so no two
    /// apps (of any kind) can share an id.
    #[test]
    fn app_registrations_id_is_globally_unique() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        let dup = diesel::insert_into(app_registrations::table)
            .values((
                app_registrations::id.eq("api-docs"),
                app_registrations::kind.eq("cloud"),
                app_registrations::position.eq(99_i64),
                app_registrations::on_homescreen.eq(true),
                app_registrations::name.eq("Dup"),
                app_registrations::local_only.eq(false),
                app_registrations::requires_tunnel.eq(false),
            ))
            .execute(&mut conn);
        assert!(
            dup.is_err(),
            "duplicate app_registrations id must violate the PK"
        );
    }

    /// The port hands back the seeded registry, in display order.
    #[test]
    fn list_registrations_returns_the_seeded_registry_in_order() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let ids: Vec<String> = store
            .list_registrations()
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(
            ids,
            vec![
                "api-view",
                "api-docs",
                "growth-chart",
                "medication-viewer",
                "precise-hbr",
                "medications-app",
                "web-trace-app",
                "web-server-docs",
                "importer-app",
                "ohif-viewer",
                "lifting-app",
            ],
        );
    }

    /// [`MIGRATIONS`] narrowed to the versions at or below `.0` — it drives a
    /// database to the state an install was in *before* a later migration ran, so a
    /// test can set up rows that migration must cope with and then let it run.
    struct MigrationsThrough(&'static str);

    impl MigrationSource<Sqlite> for MigrationsThrough {
        fn migrations(&self) -> diesel::migration::Result<Vec<Box<dyn Migration<Sqlite>>>> {
            let mut migrations = MIGRATIONS.migrations()?;
            let last = MigrationVersion::from(self.0);
            migrations.retain(|m| m.name().version() <= last);
            Ok(migrations)
        }
    }

    /// Register a user-created cloud app at the tail — the row a `POST
    /// /cloud-apps` leaves behind.
    fn create_user_cloud_app(conn: &mut SqliteConnection, id: &str) {
        sql_query(
            "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, local_only, requires_tunnel) \
             VALUES (?, 'cloud', (SELECT MAX(position) + 1 FROM app_registrations), 1, ?, 0, 0)",
        )
        .bind::<Text, _>(id)
        .bind::<Text, _>(id)
        .execute(conn)
        .expect("registration insert must succeed");
        sql_query("INSERT INTO cloud_app_configurations (id, url) VALUES (?, ?)")
            .bind::<Text, _>(id)
            .bind::<Text, _>("https://example.com/launch")
            .execute(conn)
            .expect("configuration insert must succeed");
    }

    /// The launch template a cloud row was seeded/migrated onto.
    #[derive(QueryableByName)]
    struct CloudTarget {
        #[diesel(sql_type = Text)]
        url: String,
    }

    /// After 0005 the two first-party apps are CLOUD rows pointing at the
    /// published GitHub Pages site, under their renamed ids.
    #[test]
    fn first_party_apps_are_cloud_rows_on_the_published_site() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();

        for (id, url) in [
            (
                "medications-app",
                "https://wildflowerhealth.io/medications-app/launch.html?launch={launch}&iss={origin}/fhir-r4",
            ),
            (
                "web-trace-app",
                "https://wildflowerhealth.io/web-trace-app/launch.html?launch={launch}&iss={origin}/fhir-r4",
            ),
        ] {
            let (registration, configuration) = store
                .find_app(id)
                .unwrap()
                .unwrap_or_else(|| panic!("{id} must exist under its renamed id"));
            assert!(
                matches!(configuration, AppConfiguration::Cloud(_)),
                "{id} must be a cloud app",
            );
            // client_id tracks id, as every registration does.
            assert_eq!(registration.client_id.as_deref(), Some(id));
            assert!(
                registration.requires_tunnel,
                "{id} is launched from the published site, so its `iss={{origin}}` FHIR \
                 target must resolve through the tunnel's verified origin",
            );
            let target: CloudTarget =
                sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                    .bind::<Text, _>(id)
                    .get_result(&mut conn)
                    .expect("the cloud configuration row must exist");
            assert_eq!(target.url, url);
        }

        // The old ids are fully retired.
        for old in ["wildflower-medication", "wildflower-web-trace"] {
            assert!(store.find_app(old).unwrap().is_none(), "{old} must be gone");
        }

        // Web Trace can no longer claim local-only: its assets come from the
        // published site now.
        let (web_trace, _) = store.find_app("web-trace-app").unwrap().unwrap();
        assert!(!web_trace.local_only);
    }

    /// The server-docs console is a cloud row that takes only `{origin}`, handed
    /// to it through its `?server=` contract. Unlike the SMART launchers it is not
    /// given a `{launch}` nonce (it signs in standalone), so the seeded template
    /// must carry neither `{launch}` nor `iss` — the mismatch that would otherwise
    /// leave the tile pointed at the loopback default is what this pins.
    #[test]
    fn server_docs_console_is_a_cloud_row_targeted_by_server_param() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();

        let (registration, configuration) = store
            .find_app("web-server-docs")
            .unwrap()
            .expect("web-server-docs must exist");
        assert!(
            matches!(configuration, AppConfiguration::Cloud(_)),
            "web-server-docs must be a cloud app",
        );
        // client_id tracks id, as every registration does.
        assert_eq!(registration.client_id.as_deref(), Some("web-server-docs"));
        assert!(
            registration.requires_tunnel,
            "the console fetches from `{{origin}}`, which must resolve through the \
             tunnel's verified HTTPS origin",
        );

        let target: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("web-server-docs")
                .get_result(&mut conn)
                .expect("the cloud configuration row must exist");
        assert_eq!(
            target.url,
            "https://wildflowerhealth.io/wildflower-server-docs/?server={origin}",
        );
        assert!(
            !target.url.contains("{launch}") && !target.url.contains("iss="),
            "the console reads `?server=`, not a SMART `{{launch}}`/`iss` launch",
        );
    }

    /// The Importer ships as a first-party CLOUD row (apps migration `0006`),
    /// launched from its published Pages copy — a SMART EHR launch, unlike the
    /// server-docs console's `?server=` target.
    #[test]
    fn importer_is_a_cloud_row_launched_from_the_published_site() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();

        let (registration, configuration) = store
            .find_app("importer-app")
            .unwrap()
            .expect("importer-app must exist");
        assert!(
            matches!(configuration, AppConfiguration::Cloud(_)),
            "importer-app must be a cloud app",
        );
        // client_id tracks id, as every registration does.
        assert_eq!(registration.client_id.as_deref(), Some("importer-app"));
        assert!(
            !registration.local_only,
            "the importer's assets are served from wildflowerhealth.io",
        );
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             tunnel's verified HTTPS origin",
        );

        let target: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("importer-app")
                .get_result(&mut conn)
                .expect("the cloud configuration row must exist");
        assert_eq!(
            target.url,
            "https://wildflowerhealth.io/importer-app/launch.html?launch={launch}&iss={origin}/fhir-r4",
        );
    }

    /// The OHIF imaging viewer ships as a first-party CLOUD row (apps migration
    /// `0007`), launched from its published Pages copy. Its launch URL is a
    /// route, not a `launch.html`: OHIF reads the SMART parameters off whichever
    /// route it is opened on. `0008` moved that route from the viewer's root to
    /// the FHIR Viewer mode (`/fhir-viewer`) and added `clientId`, so the
    /// template asserted here is the composed end state of `0007` + `0008`.
    #[test]
    fn ohif_viewer_is_a_cloud_row_launched_at_the_fhir_viewer_route() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();

        let (registration, configuration) = store
            .find_app("ohif-viewer")
            .unwrap()
            .expect("ohif-viewer must exist");
        assert!(
            matches!(configuration, AppConfiguration::Cloud(_)),
            "ohif-viewer must be a cloud app",
        );
        // client_id tracks id, as every registration does.
        assert_eq!(registration.client_id.as_deref(), Some("ohif-viewer"));
        assert!(
            !registration.local_only,
            "the viewer's assets are served from wildflowerhealth.io",
        );
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             tunnel's verified HTTPS origin",
        );

        let target: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("ohif-viewer")
                .get_result(&mut conn)
                .expect("the cloud configuration row must exist");
        assert_eq!(
            target.url,
            "https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer",
        );
    }

    /// Lifting ships as a first-party CLOUD row (apps migration `0010`),
    /// launched from its published Pages copy's `launch.html` — a SMART EHR
    /// launch, with no slash between `launch.html` and the query (GitHub Pages
    /// serves no file for `launch.html/`).
    #[test]
    fn lifting_app_is_a_cloud_row_launched_at_its_launch_page() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();

        let (registration, configuration) = store
            .find_app("lifting-app")
            .unwrap()
            .expect("lifting-app must exist");
        assert!(
            matches!(configuration, AppConfiguration::Cloud(_)),
            "lifting-app must be a cloud app",
        );
        // client_id tracks id, as every registration does.
        assert_eq!(registration.client_id.as_deref(), Some("lifting-app"));
        assert!(
            !registration.local_only,
            "the app's assets are served from wildflowerhealth.io",
        );
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             tunnel's verified HTTPS origin",
        );

        let target: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("lifting-app")
                .get_result(&mut conn)
                .expect("the cloud configuration row must exist");
        assert_eq!(
            target.url,
            "https://wildflowerhealth.io/lifting-app/launch.html?launch={launch}&iss={origin}/fhir-r4",
        );
    }

    /// An install already at `0009` gains Lifting when it upgrades — at the
    /// tail, after an app the user created before upgrading, since `position`
    /// is UNIQUE and `0010` appends rather than naming a literal slot.
    #[test]
    fn an_install_already_at_0009_gains_lifting_at_the_tail() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0009"),
        )
        .unwrap();
        create_user_cloud_app(&mut conn, "my-app");
        drop(conn);

        let store = SqliteAppsStore::new(pool).expect("0010 must apply over the user's app");
        let (user_app, _) = store
            .find_app("my-app")
            .unwrap()
            .expect("the user's app survives");
        let (lifting, configuration) = store
            .find_app("lifting-app")
            .unwrap()
            .expect("0010 must seed lifting-app on an upgraded install");
        assert!(matches!(configuration, AppConfiguration::Cloud(_)));
        assert_eq!(
            lifting.position,
            user_app.position + 1,
            "Lifting takes the tail, after the user's app",
        );
    }

    /// The regression `0008` exists for: migrations are run-once, so an install
    /// that already applied `0007` never re-reads it. Editing `0007`'s launch
    /// template in place would have left every upgraded install on the viewer's
    /// root with no `clientId` — a launch that lands on the worklist and
    /// authorizes with no client hint. Driving a database to `0007` first, then
    /// letting the rest run, is the only way to observe that: a fresh open
    /// applies both migrations and cannot tell the two apart.
    #[test]
    fn an_install_already_at_0007_is_upgraded_onto_the_fhir_viewer_launch() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0007"),
        )
        .unwrap();

        let seeded: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("ohif-viewer")
                .get_result(&mut conn)
                .expect("0007 must have seeded the cloud configuration row");
        assert_eq!(
            seeded.url,
            "https://wildflowerhealth.io/ohif-viewer/?launch={launch}&iss={origin}/fhir-r4",
            "0007 must stay exactly as it shipped — an install that ran it sees no edit",
        );

        persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
            .unwrap();

        let upgraded: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("ohif-viewer")
                .get_result(&mut conn)
                .expect("the cloud configuration row must survive the upgrade");
        assert_eq!(
            upgraded.url,
            "https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer",
        );
    }

    /// A bare `COUNT(*)` result.
    #[derive(QueryableByName)]
    struct RowCount {
        #[diesel(sql_type = BigInt)]
        count: i64,
    }

    fn count(conn: &mut SqliteConnection, query: &str) -> i64 {
        sql_query(query)
            .get_result::<RowCount>(conn)
            .unwrap_or_else(|e| panic!("`{query}` must read: {e}"))
            .count
    }

    /// Register an uploaded self-hosted app — the kind `0011` removes — at the
    /// tail.
    fn create_self_hosted_app(conn: &mut SqliteConnection, id: &str, port: i32) {
        sql_query(
            "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, local_only, requires_tunnel) \
             VALUES (?, 'self-hosted', (SELECT MAX(position) + 1 FROM app_registrations), 1, ?, 1, 0)",
        )
        .bind::<Text, _>(id)
        .bind::<Text, _>(id)
        .execute(conn)
        .expect("registration insert must succeed");
        sql_query(
            "INSERT INTO self_hosted_app_configurations \
             (id, port, content_folder, subdomain, seeded) VALUES (?, ?, ?, ?, 0)",
        )
        .bind::<Text, _>(id)
        .bind::<Integer, _>(port)
        .bind::<Text, _>(id)
        .bind::<Text, _>(id)
        .execute(conn)
        .expect("configuration insert must succeed");
    }

    /// An install at `0010` holding the seeded `patient-browser` and an uploaded
    /// app loses both when `0011` runs; every other app keeps its configuration
    /// and its relative order, renumbered to a dense `0..n`.
    #[test]
    fn an_install_already_at_0010_loses_its_self_hosted_apps() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0010"),
        )
        .unwrap();
        create_self_hosted_app(&mut conn, "my-upload", 8082);
        create_user_cloud_app(&mut conn, "my-cloud-app");
        drop(conn);

        let store = SqliteAppsStore::new(pool).expect("0011 must apply");
        let registrations = store.list_registrations().unwrap();
        let ids: Vec<&str> = registrations.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "api-view",
                "api-docs",
                "growth-chart",
                "medication-viewer",
                "precise-hbr",
                "medications-app",
                "web-trace-app",
                "web-server-docs",
                "importer-app",
                "ohif-viewer",
                "lifting-app",
                "my-cloud-app",
            ],
            "the self-hosted rows are gone and the rest keep their order",
        );
        let positions: Vec<i64> = registrations.iter().map(|r| r.position).collect();
        let dense: Vec<i64> = (0..).take(positions.len()).collect();
        assert_eq!(positions, dense, "positions are renumbered to a dense 0..n");
        for registration in &registrations {
            assert!(
                store.find_app(&registration.id).unwrap().is_some(),
                "{} keeps its configuration across the rebuild",
                registration.id,
            );
        }

        let mut conn = store.pool().get().unwrap();
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM sqlite_master \
                 WHERE name = 'self_hosted_app_configurations'",
            ),
            0,
            "the self-hosted configuration table is dropped",
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'",
            ),
            0,
            "no rebuild scratch table is left behind",
        );
    }

    /// After `0011` the rebuilt registry still enforces what `0001` declared:
    /// `kind` admits only system and cloud, and deleting a registration cascades
    /// to its configuration (the rebuilt configuration tables reference the final
    /// `app_registrations` name).
    #[test]
    fn the_rebuilt_registry_narrows_kind_and_keeps_its_cascade() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();

        let rejected = sql_query(
            "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, local_only, requires_tunnel) \
             VALUES ('x', 'self-hosted', 99, 1, 'x', 1, 0)",
        )
        .execute(&mut conn);
        assert!(
            rejected.is_err(),
            "the kind CHECK must reject a removed kind"
        );

        sql_query("DELETE FROM app_registrations WHERE id IN ('growth-chart', 'api-docs')")
            .execute(&mut conn)
            .unwrap();
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM cloud_app_configurations WHERE id = 'growth-chart'",
            ),
            0,
            "the cloud configuration cascades",
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM system_app_configurations WHERE id = 'api-docs'",
            ),
            0,
            "the system configuration cascades",
        );
    }

    /// Reverting `0011` restores the `0010` schema — the wider `kind` CHECK and an
    /// empty self-hosted configuration table — over the surviving rows.
    #[test]
    fn reverting_0011_restores_the_0010_schema() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        let migration_0011 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0011"))
            .expect("0011 is embedded");
        migration_0011.revert(&mut conn).expect("revert 0011");

        create_self_hosted_app(&mut conn, "my-upload", 8082);
        assert_eq!(
            count(&mut conn, "SELECT COUNT(*) AS count FROM app_registrations",),
            12,
            "the eleven surviving apps plus the new self-hosted row",
        );
        drop(conn);
        assert!(
            store.find_app("lifting-app").unwrap().is_some(),
            "the surviving apps keep their configurations",
        );
    }
}

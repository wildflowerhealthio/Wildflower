//! The `SqliteAppsStore` adapter — the `SQLite` implementation of the
//! [`AppsStore`](crate::domain::AppsStore) port. Holds the app-wide r2d2 pool of
//! Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared
//! database file, applies the embedded apps migrations once on construction, and
//! implements the port by delegating to the query bodies in
//! [`crate::db::app_registration`]. Mirrors `collector-rust`'s
//! `SqliteRemotesStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::db::app_registration;
use crate::domain::{AppInsertError, AppRegistration, AppsError, AppsStore};

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`persistence_rust::run_diesel_migrations`], so
/// apps' `0001` and another diesel slice's `0001` never collide.
const MIGRATION_NAMESPACE: &str = "apps";

/// The apps migrations, embedded from the crate's `migrations/` tree at compile
/// time (diesel layout: `<version>_<name>/up.sql` + `down.sql`). Applied once per
/// database in [`SqliteAppsStore::new`] via
/// [`persistence_rust::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`] (see
/// that runner for why the stock diesel harness can't be used across slices).
/// The table definition and each shipped app's seed are separate migrations
/// (see `migrations/`); because each runs only once per database, a user-deleted
/// seed stays deleted across upgrades. The debug-only `…-dev` rows are
/// deliberately NOT migrations — see `apps-rust/src/dev_seed.rs`.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`AppsStore`] port — serves the `app_registrations`
/// rows. Cheap to clone (the pool is an `Arc` inside), so it drops straight into
/// the axum state.
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
    /// opaque [`AppsError::Infrastructure`]. Each query body runs on one of
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
/// query body in [`crate::db::app_registration`]. The bodies live there so this
/// file stays the migration + pool handle, and the query SQL stays next to the
/// `table!` it maps. Every method returns the port's PRIMITIVE shape — absence as
/// `None`, delete outcome as `bool`, an insert that wrote nothing as the typed
/// [`AppInsertError`] — leaving the semantic verdicts to the
/// [`capabilities`](crate::domain::capabilities).
impl AppsStore for SqliteAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        let mut conn = self.connection()?;
        app_registration::list_registrations_on(&mut conn)
    }

    fn find_app(&self, id: &str) -> Result<Option<AppRegistration>, AppsError> {
        app_registration::find_app(&mut *self.connection()?, id)
    }

    fn insert_app(
        &self,
        registration: &AppRegistration,
    ) -> Result<Result<AppRegistration, AppInsertError>, AppsError> {
        app_registration::insert_app(&mut self.connection()?, registration)
    }

    fn replace_app(
        &self,
        registration: &AppRegistration,
    ) -> Result<Option<AppRegistration>, AppsError> {
        app_registration::replace_app(&mut *self.connection()?, registration)
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
        app_registration::delete_app(&mut *self.connection()?, id)
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
    use persistence_rust::DieselPool;

    use super::*;
    use crate::db::app_registration::app_registrations;

    /// The seeded registry, in display order.
    const SEEDED_IDS: [&str; 9] = [
        "growth-chart",
        "medication-viewer",
        "precise-hbr",
        "medications-app",
        "web-trace-app",
        "web-server-docs",
        "importer-app",
        "ohif-viewer",
        "lifting-app",
    ];

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
        assert_eq!(row_count, 9, "exactly the nine seeded default apps");
    }

    /// The `app_registrations` primary key gives global id uniqueness — a second
    /// registration with a seeded id is rejected by the PK, so no two apps can
    /// share an id.
    #[test]
    fn app_registrations_id_is_globally_unique() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        let dup = diesel::insert_into(app_registrations::table)
            .values((
                app_registrations::id.eq("growth-chart"),
                app_registrations::position.eq(99_i64),
                app_registrations::on_homescreen.eq(true),
                app_registrations::name.eq("Dup"),
                app_registrations::url.eq("https://example.com/dup"),
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
        assert_eq!(ids, SEEDED_IDS);
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

    /// A fresh in-memory pool migrated through `version` — an install that has not
    /// yet run the migrations after it.
    fn pool_migrated_through(version: &'static str) -> DieselPool {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough(version),
        )
        .unwrap();
        drop(conn);
        pool
    }

    /// The migration with this version, as embedded.
    fn embedded_migration(version: &str) -> Box<dyn Migration<Sqlite>> {
        MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from(version))
            .unwrap_or_else(|| panic!("{version} is embedded"))
    }

    /// Register a user-created cloud app at the tail in the `0001`–`0011` layout —
    /// the registration plus its `cloud_app_configurations` row a `POST
    /// /cloud-apps` left behind.
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

    /// The launch template a `0001`–`0011` cloud configuration row holds.
    #[derive(QueryableByName)]
    struct CloudTarget {
        #[diesel(sql_type = Text)]
        url: String,
    }

    /// The stored launch template of a seeded app, read through the port.
    fn stored_url(store: &SqliteAppsStore, id: &str) -> String {
        store
            .find_app(id)
            .unwrap()
            .unwrap_or_else(|| panic!("{id} must exist"))
            .url
            .to_string()
    }

    /// The first-party apps point at the published GitHub Pages site, under the
    /// ids `0005` gave them.
    #[test]
    fn first_party_apps_launch_from_the_published_site() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

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
            let registration = store
                .find_app(id)
                .unwrap()
                .unwrap_or_else(|| panic!("{id} must exist under its renamed id"));
            // A first-party app's client_id equals its id.
            assert_eq!(registration.client_id.as_deref(), Some(id));
            assert!(
                registration.requires_tunnel,
                "{id} is launched from the published site, so its `iss={{origin}}` FHIR \
                 target must resolve through the tunnel's verified origin",
            );
            assert_eq!(registration.url.to_string(), url);
        }

        // The old ids are fully retired.
        for old in ["wildflower-medication", "wildflower-web-trace"] {
            assert!(store.find_app(old).unwrap().is_none(), "{old} must be gone");
        }
    }

    /// The server-docs console takes only `{origin}`, handed to it through its
    /// `?server=` contract. Unlike the SMART launchers it is not given a
    /// `{launch}` nonce (it signs in standalone), so the seeded template must carry
    /// neither `{launch}` nor `iss` — the mismatch that would otherwise leave the
    /// tile pointed at the loopback default is what this pins.
    #[test]
    fn server_docs_console_is_targeted_by_server_param() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let registration = store
            .find_app("web-server-docs")
            .unwrap()
            .expect("web-server-docs must exist");
        // A first-party app's client_id equals its id.
        assert_eq!(registration.client_id.as_deref(), Some("web-server-docs"));
        assert!(
            registration.requires_tunnel,
            "the console fetches from `{{origin}}`, which must resolve through the \
             tunnel's verified HTTPS origin",
        );

        let url = registration.url.to_string();
        assert_eq!(
            url,
            "https://wildflowerhealth.io/wildflower-server-docs/?server={origin}",
        );
        assert!(
            !url.contains("{launch}") && !url.contains("iss="),
            "the console reads `?server=`, not a SMART `{{launch}}`/`iss` launch",
        );
    }

    /// The Importer ships as a first-party app (apps migration `0006`), launched
    /// from its published Pages copy — a SMART EHR launch, unlike the server-docs
    /// console's `?server=` target.
    #[test]
    fn importer_launches_from_the_published_site() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let registration = store
            .find_app("importer-app")
            .unwrap()
            .expect("importer-app must exist");
        // A first-party app's client_id equals its id.
        assert_eq!(registration.client_id.as_deref(), Some("importer-app"));
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             tunnel's verified HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/importer-app/launch.html?launch={launch}&iss={origin}/fhir-r4",
        );
    }

    /// The OHIF imaging viewer ships as a first-party app (apps migration `0007`),
    /// launched from its published Pages copy. Its launch URL is a route, not a
    /// `launch.html`: OHIF reads the SMART parameters off whichever route it is
    /// opened on. `0008` moved that route from the viewer's root to the FHIR
    /// Viewer mode (`/fhir-viewer`) and added `clientId`, so the template asserted
    /// here is the composed end state of `0007` + `0008`.
    #[test]
    fn ohif_viewer_launches_at_the_fhir_viewer_route() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let registration = store
            .find_app("ohif-viewer")
            .unwrap()
            .expect("ohif-viewer must exist");
        // A first-party app's client_id equals its id.
        assert_eq!(registration.client_id.as_deref(), Some("ohif-viewer"));
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             tunnel's verified HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer",
        );
    }

    /// Lifting ships as a first-party app (apps migration `0010`), launched from
    /// its published Pages copy's `launch.html` — a SMART EHR launch, with no slash
    /// between `launch.html` and the query (GitHub Pages serves no file for
    /// `launch.html/`).
    #[test]
    fn lifting_app_launches_at_its_launch_page() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let registration = store
            .find_app("lifting-app")
            .unwrap()
            .expect("lifting-app must exist");
        // A first-party app's client_id equals its id.
        assert_eq!(registration.client_id.as_deref(), Some("lifting-app"));
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             tunnel's verified HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/lifting-app/launch.html?launch={launch}&iss={origin}/fhir-r4",
        );
    }

    /// An install already at `0009` gains Lifting when it upgrades — at the
    /// tail, after an app the user created before upgrading, since `position`
    /// is UNIQUE and `0010` appends rather than naming a literal slot.
    #[test]
    fn an_install_already_at_0009_gains_lifting_at_the_tail() {
        let pool = pool_migrated_through("0009");
        create_user_cloud_app(&mut pool.get().unwrap(), "my-app");

        let store = SqliteAppsStore::new(pool).expect("0010 must apply over the user's app");
        let user_app = store
            .find_app("my-app")
            .unwrap()
            .expect("the user's app survives");
        let lifting = store
            .find_app("lifting-app")
            .unwrap()
            .expect("0010 must seed lifting-app on an upgraded install");
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
        let pool = pool_migrated_through("0007");
        let seeded: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = ?")
                .bind::<Text, _>("ohif-viewer")
                .get_result(&mut pool.get().unwrap())
                .expect("0007 must have seeded the cloud configuration row");
        assert_eq!(
            seeded.url,
            "https://wildflowerhealth.io/ohif-viewer/?launch={launch}&iss={origin}/fhir-r4",
            "0007 must stay exactly as it shipped — an install that ran it sees no edit",
        );

        let store = SqliteAppsStore::new(pool).expect("the later migrations must apply");
        assert_eq!(
            stored_url(&store, "ohif-viewer"),
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

    /// How many schema objects of this name exist.
    fn schema_objects_named(conn: &mut SqliteConnection, name: &str) -> i64 {
        sql_query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?")
            .bind::<Text, _>(name)
            .get_result::<RowCount>(conn)
            .expect("sqlite_master must read")
            .count
    }

    /// How many rebuild scratch tables (`…_new`) are left behind.
    fn scratch_tables(conn: &mut SqliteConnection) -> i64 {
        count(
            conn,
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'",
        )
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
        let pool = pool_migrated_through("0010");
        let mut conn = pool.get().unwrap();
        create_self_hosted_app(&mut conn, "my-upload", 8082);
        create_user_cloud_app(&mut conn, "my-cloud-app");
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0011"),
        )
        .expect("0011 must apply");

        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM app_registrations WHERE kind = 'self-hosted'",
            ),
            0,
            "the self-hosted rows are gone",
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM app_registrations AS registration \
                 WHERE registration.position = \
                   (SELECT COUNT(*) FROM app_registrations AS earlier \
                     WHERE earlier.position < registration.position)",
            ),
            count(&mut conn, "SELECT COUNT(*) AS count FROM app_registrations"),
            "positions are renumbered to a dense 0..n",
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM app_registrations \
                 WHERE id NOT IN (SELECT id FROM cloud_app_configurations) \
                   AND id NOT IN (SELECT id FROM system_app_configurations)",
            ),
            0,
            "every surviving app keeps its configuration across the rebuild",
        );
        assert_eq!(
            schema_objects_named(&mut conn, "self_hosted_app_configurations"),
            0,
            "the self-hosted configuration table is dropped",
        );
        assert_eq!(
            scratch_tables(&mut conn),
            0,
            "no rebuild scratch table is left behind"
        );
    }

    /// After `0011` the rebuilt registry still enforces what `0001` declared:
    /// `kind` admits only system and cloud, and deleting a registration cascades
    /// to its configuration (the rebuilt configuration tables reference the final
    /// `app_registrations` name).
    #[test]
    fn the_0011_registry_narrows_kind_and_keeps_its_cascade() {
        let pool = pool_migrated_through("0011");
        let mut conn = pool.get().unwrap();

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
        let pool = pool_migrated_through("0011");
        let mut conn = pool.get().unwrap();
        embedded_migration("0011")
            .revert(&mut conn)
            .expect("revert 0011");

        create_self_hosted_app(&mut conn, "my-upload", 8082);
        assert_eq!(
            count(&mut conn, "SELECT COUNT(*) AS count FROM app_registrations"),
            12,
            "the eleven surviving apps plus the new self-hosted row",
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM cloud_app_configurations WHERE id = 'lifting-app'",
            ),
            1,
            "the surviving apps keep their configurations",
        );
    }

    /// An install at `0011` — the two system apps, the seeded cloud apps, and a
    /// user's own cloud app, one of them hidden — upgrades onto the single table:
    /// the system apps are gone, every cloud app carries its launch template on its
    /// registration with its placement and flags intact, positions are a dense
    /// `0..n` in the same order, and the `kind` column and both configuration
    /// tables are dropped.
    #[test]
    fn an_install_already_at_0011_collapses_onto_app_registrations() {
        let pool = pool_migrated_through("0011");
        let mut conn = pool.get().unwrap();
        create_user_cloud_app(&mut conn, "my-cloud-app");
        sql_query("UPDATE app_registrations SET on_homescreen = 0 WHERE id = 'precise-hbr'")
            .execute(&mut conn)
            .unwrap();
        let growth_chart_before: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = 'growth-chart'")
                .get_result(&mut conn)
                .unwrap();
        drop(conn);

        let store = SqliteAppsStore::new(pool).expect("0012 must apply");
        let registrations = store.list_registrations().unwrap();
        let ids: Vec<&str> = registrations.iter().map(|r| r.id.as_str()).collect();
        let mut expected: Vec<&str> = SEEDED_IDS.to_vec();
        expected.push("my-cloud-app");
        assert_eq!(
            ids, expected,
            "the system apps are gone and the rest keep their order"
        );
        let positions: Vec<i64> = registrations.iter().map(|r| r.position).collect();
        let dense: Vec<i64> = (0..).take(positions.len()).collect();
        assert_eq!(positions, dense, "positions are renumbered to a dense 0..n");

        assert_eq!(stored_url(&store, "growth-chart"), growth_chart_before.url);
        let user_app = store.find_app("my-cloud-app").unwrap().unwrap();
        assert_eq!(user_app.url.to_string(), "https://example.com/launch");
        assert!(user_app.client_id.is_none());
        assert!(
            !store
                .find_app("precise-hbr")
                .unwrap()
                .unwrap()
                .on_homescreen,
            "a hidden app stays hidden",
        );

        let mut conn = store.pool().get().unwrap();
        for dropped in ["cloud_app_configurations", "system_app_configurations"] {
            assert_eq!(
                schema_objects_named(&mut conn, dropped),
                0,
                "{dropped} is dropped"
            );
        }
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM pragma_table_info('app_registrations') \
                 WHERE name = 'kind'",
            ),
            0,
            "the kind column is dropped",
        );
        assert_eq!(
            scratch_tables(&mut conn),
            0,
            "no rebuild scratch table is left behind"
        );
    }

    /// The collapsed registry requires a launch template on every row and keeps
    /// `position` UNIQUE.
    #[test]
    fn the_collapsed_registry_requires_a_url_and_a_unique_position() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        let without_url = sql_query(
            "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, requires_tunnel) \
             VALUES ('x', 99, 1, 'x', 0)",
        )
        .execute(&mut conn);
        assert!(without_url.is_err(), "url is NOT NULL");

        let tied = sql_query(
            "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, url, requires_tunnel) \
             VALUES ('x', 0, 1, 'x', 'https://example.com', 0)",
        )
        .execute(&mut conn);
        assert!(tied.is_err(), "position stays UNIQUE");
    }

    /// Reverting `0012` restores the `0011` schema over the surviving apps: each
    /// registration is a `cloud` row whose `url` is back in
    /// `cloud_app_configurations`, `system_app_configurations` exists empty, and
    /// deleting a registration cascades to its configuration (the restored tables
    /// reference the final `app_registrations` name).
    #[test]
    fn reverting_0012_restores_the_0011_schema() {
        let pool = pool_migrated_through("0012");
        let mut conn = pool.get().unwrap();
        let lifting: CloudTarget =
            sql_query("SELECT url FROM app_registrations WHERE id = 'lifting-app'")
                .get_result(&mut conn)
                .unwrap();
        embedded_migration("0012")
            .revert(&mut conn)
            .expect("revert 0012");

        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM app_registrations WHERE kind = 'cloud'",
            ),
            9,
            "every surviving app is a cloud row",
        );
        let restored: CloudTarget =
            sql_query("SELECT url FROM cloud_app_configurations WHERE id = 'lifting-app'")
                .get_result(&mut conn)
                .expect("the cloud configuration is restored");
        assert_eq!(restored.url, lifting.url);
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM system_app_configurations",
            ),
            0,
            "the system configuration table is restored empty",
        );

        sql_query("DELETE FROM app_registrations WHERE id = 'lifting-app'")
            .execute(&mut conn)
            .unwrap();
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM cloud_app_configurations WHERE id = 'lifting-app'",
            ),
            0,
            "the restored configuration cascades",
        );
        assert_eq!(
            scratch_tables(&mut conn),
            0,
            "no rebuild scratch table is left behind"
        );
    }

    /// An install at `0012` loses the `local_only` column when `0013` runs, and
    /// every app — a user's own included — keeps its row, placement, and launch
    /// template.
    #[test]
    fn an_install_already_at_0012_drops_local_only() {
        let pool = pool_migrated_through("0012");
        let mut conn = pool.get().unwrap();
        sql_query(
            "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, url, local_only, requires_tunnel) \
             VALUES ('my-app', 9, 0, 'My App', 'https://example.com/launch', 0, 0)",
        )
        .execute(&mut conn)
        .expect("a 0012 registration insert must succeed");
        drop(conn);

        let store = SqliteAppsStore::new(pool).expect("0013 must apply");
        let user_app = store
            .find_app("my-app")
            .unwrap()
            .expect("the user's app survives");
        assert_eq!(user_app.position, 9);
        assert!(!user_app.on_homescreen);
        assert_eq!(user_app.url.to_string(), "https://example.com/launch");
        assert_eq!(
            store.list_registrations().unwrap().len(),
            SEEDED_IDS.len() + 1,
            "every app survives",
        );

        let mut conn = store.pool().get().unwrap();
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM pragma_table_info('app_registrations') \
                 WHERE name = 'local_only'",
            ),
            0,
            "the local_only column is dropped",
        );
    }

    /// Reverting `0013` restores `local_only`, cleared on every row.
    #[test]
    fn reverting_0013_restores_local_only_cleared() {
        let pool = pool_migrated_through("0013");
        let mut conn = pool.get().unwrap();
        embedded_migration("0013")
            .revert(&mut conn)
            .expect("revert 0013");
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) AS count FROM app_registrations WHERE local_only = 0",
            ),
            count(&mut conn, "SELECT COUNT(*) AS count FROM app_registrations"),
            "every row reads local_only = 0",
        );
    }

    /// An install at `0013` holding user-created apps with origin-relative
    /// templates loses exactly those when `0014` runs; every absolute-URL app
    /// keeps its template, and positions are a dense `0..n` in the same order.
    #[test]
    fn an_install_already_at_0013_loses_its_origin_relative_apps() {
        let pool = pool_migrated_through("0013");
        let mut conn = pool.get().unwrap();
        for (id, url) in [
            ("relative-path", "/my/app"),
            ("kept-https", "https://example.com/launch?iss={origin}"),
            ("origin-template", "{origin}/x?launch={launch}"),
            ("kept-http", "http://localhost:5199/launch.html"),
        ] {
            sql_query(
                "INSERT INTO app_registrations \
                 (id, position, on_homescreen, name, url, requires_tunnel) \
                 VALUES (?, (SELECT MAX(position) + 1 FROM app_registrations), 1, ?, ?, 0)",
            )
            .bind::<Text, _>(id)
            .bind::<Text, _>(id)
            .bind::<Text, _>(url)
            .execute(&mut conn)
            .expect("a 0013 registration insert must succeed");
        }
        drop(conn);

        let store = SqliteAppsStore::new(pool).expect("0014 must apply");
        let registrations = store.list_registrations().unwrap();
        let ids: Vec<&str> = registrations.iter().map(|r| r.id.as_str()).collect();
        let mut expected: Vec<&str> = SEEDED_IDS.to_vec();
        expected.extend(["kept-https", "kept-http"]);
        assert_eq!(
            ids, expected,
            "the origin-relative apps are gone and the rest keep their order"
        );
        let positions: Vec<i64> = registrations.iter().map(|r| r.position).collect();
        let dense: Vec<i64> = (0..).take(positions.len()).collect();
        assert_eq!(positions, dense, "positions are renumbered to a dense 0..n");
    }
}

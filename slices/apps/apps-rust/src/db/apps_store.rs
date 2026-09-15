//! The `SqliteAppsStore` adapter — the `SQLite` implementation of the
//! [`AppsStore`](crate::domain::AppsStore) port. Holds the app-wide r2d2 pool of
//! Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared
//! database file, applies the embedded apps migrations once on construction, and
//! implements the port by delegating to the per-kind query bodies in
//! [`crate::db::app_registration`] / [`crate::db::cloud_apps`] /
//! [`crate::db::self_hosted_apps`] / [`crate::db::all_kinds_apps`]. Mirrors
//! `collector-rust`'s `SqliteRemotesStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::db::{all_kinds_apps, app_registration, cloud_apps, self_hosted_apps};
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration,
    CloudInsertError, SelfHostedAppConfiguration, SelfHostedAppConfigurationPayload,
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
/// app served from the same site; and `0007` appends the OHIF imaging viewer, a
/// fourth CLOUD app from that site. Because each migration runs only once per
/// database, a user-deleted seed stays deleted across upgrades. The debug-only
/// `…-dev` self-hosted siblings are deliberately NOT migrations — see
/// `apps-rust/src/dev_seed.rs`.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`AppsStore`] port — serves the registrations plus
/// the cloud + self-hosted configurations. Cheap to clone (the pool is an `Arc`
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
/// [`crate::db::self_hosted_apps`] / [`crate::db::all_kinds_apps`]). The bodies live
/// there so this file stays the migration + pool handle, and the query SQL stays
/// next to the `table!` + row types it maps. Every method returns the port's PRIMITIVE shape
/// — absence as `None`, delete outcome as `bool`, a cloud insert that wrote nothing
/// as the granular typed [`CloudInsertError`] — leaving the semantic verdicts to
/// [`crate::domain::actions`]. (The self-hosted insert is the exception: it maps its
/// taken-slug / port-exhaustion outcomes onto `AppsError` directly.)
impl AppsStore for SqliteAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        let mut conn = self.connection()?;
        app_registration::list_registrations_on(&mut conn)
    }

    fn find_app(&self, id: &str) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError> {
        let mut conn = self.connection()?;
        all_kinds_apps::find_app_on(&mut conn, id)
    }

    fn list_self_hosted_apps(
        &self,
    ) -> Result<Vec<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
        let mut conn = self.connection()?;
        self_hosted_apps::list_self_hosted_apps_on(&mut conn)
    }

    fn insert_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError> {
        cloud_apps::insert_cloud_app(&mut self.connection()?, registration, config)
    }

    fn insert_self_hosted_app(
        &self,
        registration: &AppRegistration,
        payload: &SelfHostedAppConfigurationPayload,
        reserved_ports: &[u16],
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        self_hosted_apps::insert_self_hosted_app(
            &mut self.connection()?,
            registration,
            payload,
            reserved_ports,
        )
    }

    fn replace_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError> {
        cloud_apps::replace_cloud_app(&mut self.connection()?, registration, config)
    }

    fn replace_self_hosted_app(
        &self,
        registration: &AppRegistration,
        payload: &SelfHostedAppConfigurationPayload,
    ) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
        self_hosted_apps::replace_self_hosted_app(&mut self.connection()?, registration, payload)
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
                "patient-browser",
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
            ],
        );
    }

    /// The loopback origin a self-hosted row was seeded onto.
    #[derive(QueryableByName)]
    struct SeededOrigin {
        #[diesel(sql_type = Integer)]
        port: i32,
        #[diesel(sql_type = Text)]
        subdomain: String,
    }

    /// [`MIGRATIONS`] narrowed to the versions at or below `.0` — it drives a
    /// database to the state an install was in *before* a seed migration ran, so a
    /// test can occupy the port and subdomain that seed prefers and then let it run.
    struct MigrationsThrough(&'static str);

    impl MigrationSource<Sqlite> for MigrationsThrough {
        fn migrations(&self) -> diesel::migration::Result<Vec<Box<dyn Migration<Sqlite>>>> {
            let mut migrations = MIGRATIONS.migrations()?;
            let last = MigrationVersion::from(self.0);
            migrations.retain(|m| m.name().version() <= last);
            Ok(migrations)
        }
    }

    /// Register a non-seeded self-hosted app holding `port` and `subdomain` — the
    /// row an upload leaves behind (its subdomain is its slug, which is its id).
    fn occupy(conn: &mut SqliteConnection, slug: &str, port: i32) {
        sql_query(
            "INSERT INTO app_registrations \
             (id, kind, position, on_homescreen, name, local_only, requires_tunnel) \
             VALUES (?, 'self-hosted', (SELECT MAX(position) + 1 FROM app_registrations), 1, ?, 1, 0)",
        )
        .bind::<Text, _>(slug)
        .bind::<Text, _>(slug)
        .execute(conn)
        .expect("registration insert must succeed");
        sql_query(
            "INSERT INTO self_hosted_app_configurations \
             (id, port, content_folder, subdomain, seeded) VALUES (?, ?, ?, ?, 0)",
        )
        .bind::<Text, _>(slug)
        .bind::<Integer, _>(port)
        .bind::<Text, _>(format!("{slug}-folder"))
        .bind::<Text, _>(slug)
        .execute(conn)
        .expect("configuration insert must succeed");
    }

    fn origin_of(conn: &mut SqliteConnection, id: &str) -> SeededOrigin {
        sql_query("SELECT port, subdomain FROM self_hosted_app_configurations WHERE id = ?")
            .bind::<Text, _>(id)
            .get_result(conn)
            .expect("the seeded self-hosted row must exist")
    }

    /// The launch template a cloud row was seeded/migrated onto.
    #[derive(QueryableByName)]
    struct CloudTarget {
        #[diesel(sql_type = Text)]
        url: String,
    }

    /// After 0005 the two first-party apps are CLOUD rows pointing at the
    /// published GitHub Pages site, under their renamed ids, and their
    /// self-hosted payloads are gone. Patient Browser is untouched — it is still
    /// the one seeded self-hosted app, on the port 0002 documents.
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
            // The client_id must track the id: the host's self-hosted redirect
            // resolver looks an app up by client_id.
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
            let leftovers: i64 = sql_query(
                "SELECT COUNT(*) AS count FROM self_hosted_app_configurations WHERE id = ?",
            )
            .bind::<Text, _>(id)
            .get_result::<RowCount>(&mut conn)
            .expect("count must read")
            .count;
            assert_eq!(leftovers, 0, "{id}'s self-hosted payload must be gone");
        }

        // The old ids are fully retired.
        for old in ["wildflower-medication", "wildflower-web-trace"] {
            assert!(store.find_app(old).unwrap().is_none(), "{old} must be gone");
        }

        // Web Trace can no longer claim local-only: its assets come from the
        // published site now.
        let (web_trace, _) = store.find_app("web-trace-app").unwrap().unwrap();
        assert!(!web_trace.local_only);

        // Patient Browser is untouched by 0005.
        let patient_browser = origin_of(&mut conn, "patient-browser");
        assert_eq!(
            (patient_browser.port, patient_browser.subdomain.as_str()),
            (8081, "patient-browser"),
        );
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
    /// `0007`), launched from its published Pages copy. Its launch URL is the
    /// viewer's root, not a `launch.html`: OHIF reads the SMART parameters off
    /// whichever route it is opened on, and the root is the only route GitHub
    /// Pages serves as a real file.
    #[test]
    fn ohif_viewer_is_a_cloud_row_launched_at_its_root() {
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

    /// A bare `COUNT(*)` result.
    #[derive(QueryableByName)]
    struct RowCount {
        #[diesel(sql_type = BigInt)]
        count: i64,
    }

    /// `port` and `subdomain` are UNIQUE, so an install that uploaded an app onto
    /// 8091 / `web-trace` before upgrading into 0004 would abort the migration —
    /// and with it `SqliteAppsStore::new`, leaving the registry unopenable. The
    /// seed allocates around the collision instead: the next port above the
    /// allocated ones, and the app id as the subdomain.
    #[test]
    fn web_trace_seed_allocates_around_a_taken_port_and_subdomain() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0003"),
        )
        .unwrap();
        occupy(&mut conn, "web-trace", 8091);

        // Stops at 0004 deliberately: 0005 moves this app to a cloud row and drops
        // the self-hosted payload, so the fallback under test is only observable
        // at the version that wrote it.
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0004"),
        )
        .expect("0004 must apply over the collision, not abort the migration run");

        let seeded = origin_of(&mut conn, "wildflower-web-trace");
        assert_eq!(seeded.port, 8092, "the next port above every allocated one");
        assert_eq!(seeded.subdomain, "wildflower-web-trace");
        let upload = origin_of(&mut conn, "web-trace");
        assert_eq!(
            (upload.port, upload.subdomain.as_str()),
            (8091, "web-trace"),
            "the upload keeps the origin it was allocated — the seed moves, not it",
        );
    }

    /// The same for 0003, whose 8090 / `medication` pair is taken by an upload named
    /// "Medication". 0004 then runs over the *displaced* medication row: its 8091 is
    /// gone too, so it allocates once more — the fallbacks compose down the chain.
    #[test]
    fn medication_seed_allocates_around_a_taken_port_and_subdomain() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0002"),
        )
        .unwrap();
        occupy(&mut conn, "medication", 8090);

        // Stops at 0004 for the same reason as the test above.
        persistence_rust::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0004"),
        )
        .expect("0003 must apply over the collision, not abort the migration run");

        let medication = origin_of(&mut conn, "wildflower-medication");
        assert_eq!(
            (medication.port, medication.subdomain.as_str()),
            (8091, "wildflower-medication"),
        );
        let web_trace = origin_of(&mut conn, "wildflower-web-trace");
        assert_eq!(
            (web_trace.port, web_trace.subdomain.as_str()),
            (8092, "web-trace"),
            "0004's own subdomain was never taken — only its port had to move",
        );
    }
}

//! The `SqliteGrantStore` adapter — the `SQLite` implementation of the
//! [`GrantStore`](crate::domain::GrantStore) port. Holds the app-wide r2d2
//! pool of diesel `SqliteConnection`s (`wildflowerhealthio_persistence::DieselPool`)
//! onto the shared database file, applies the embedded authorization server
//! migrations once on construction (under this slice's [`MIGRATION_NAMESPACE`]),
//! and opens the port's two scopes on a checked-out connection: a read scope
//! in autocommit, a write scope in `BEGIN IMMEDIATE`. The primitives the
//! scopes hand out are implemented per concern, in the sibling `db/*` files.

use anyhow::Context;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use wildflowerhealthio_persistence::{DieselPool, PooledDieselConnection};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::GrantStore;

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`wildflowerhealthio_persistence::run_diesel_migrations`], so
/// the authorization server's `0001` and another diesel slice's `0001` never collide — the
/// stock diesel harness records versions in a single un-namespaced
/// `__diesel_schema_migrations` table, where a second diesel slice's `0001`
/// would silently mask the first.
///
/// Still `gatekeeper`: existing databases record their migrations under it.
const MIGRATION_NAMESPACE: &str = "gatekeeper";

/// The authorization server migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteGrantStore::new`] via
/// [`wildflowerhealthio_persistence::run_diesel_migrations`] under [`MIGRATION_NAMESPACE`]
/// (see that runner for why the stock diesel harness can't be shared across
/// slices). Each migration's header says what it changes and why (see
/// `migrations/`); because each runs only once per database, an upgrade neither
/// re-drops nor re-seeds.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`GrantStore`] port. Cheap to clone (the
/// pool is an `Arc` inside), so it drops straight into the axum state.
#[derive(Clone)]
pub struct SqliteGrantStore {
    // The app-wide r2d2 pool onto the shared database file, built and owned by
    // the host (`wildflowerhealthio_persistence::open_pool`) — the same pool the other
    // diesel-backed slices' stores ride. Diesel's connection API is `&mut`, so
    // each call checks a connection out of the pool rather than sharing one
    // behind a mutex; the pool (an `Arc` inside) makes the store cheap to clone
    // into the axum state. These are additional openers onto the same file the host's
    // rusqlite `persistence-rust::Connection` serves the remaining rusqlite
    // slices from — SQLite permits multiple connections per file; the pool's
    // `busy_timeout` pragma rides out the brief write locks any connection takes
    // (see `wildflowerhealthio_persistence::open_pool`).
    pool: DieselPool,
}

impl SqliteGrantStore {
    /// Wrap the host-owned connection `pool` and apply pending authorization server
    /// migrations once, on a single checked-out connection, under
    /// `MIGRATION_NAMESPACE`. The host builds the app-wide pool (via
    /// `wildflowerhealthio_persistence::open_pool`) on the same file its rusqlite connection
    /// opens for the other slices; both coexist (see the `pool` field).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run authorization server migrations")?;
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .context("failed to apply authorization server migrations")?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call
    /// is an independent, freshly-migrated database. Uses
    /// `wildflowerhealthio_persistence::open_in_memory_pool`, whose shared-cache URI keeps
    /// the pooled connections on one in-memory database (a naive `:memory:`
    /// pool gives each connection its own empty db).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(wildflowerhealthio_persistence::open_in_memory_pool()?)
    }

    /// Check a connection out of the pool, mapping a checkout failure to the
    /// port's opaque [`AuthorizationServerError::Infrastructure`] — the shared first step
    /// of every method in the port impl below. Each query in the sibling `db/*`
    /// modules runs on one of these, checked out per call — diesel's connection
    /// API is `&mut`, so the store hands out a fresh connection rather than
    /// sharing one.
    fn connection(&self) -> Result<PooledDieselConnection, AuthorizationServerError> {
        self.pool.get().map_err(|e| {
            AuthorizationServerError::infrastructure("failed to check out a connection", e)
        })
    }

    /// The pool, for tests that tamper with stored rows via raw SQL to prove the
    /// column mappings reject an out-of-domain stored value as a typed read error
    /// (rather than a panic) at the read boundary.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The [`GrantTx`](crate::domain::GrantTx) a [`SqliteGrantStore`] scope
/// hands its closure: one checked-out diesel connection, in autocommit for a
/// read scope and inside `BEGIN IMMEDIATE` for a write scope. Each concern's
/// `db/` file implements its trait on it, next to that concern's `table!`.
///
/// `pub` only because it is the adapter's [`GrantStore::Tx`]; out-of-crate
/// callers can name it but reach nothing except through the traits.
pub struct SqliteGrantTx<'a> {
    pub(in crate::db) conn: &'a mut SqliteConnection,
}

impl GrantStore for SqliteGrantStore {
    type Tx<'a> = SqliteGrantTx<'a>;

    fn read<T, E: From<AuthorizationServerError>>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut conn = self.connection()?;
        f(&mut SqliteGrantTx { conn: &mut conn })
    }

    fn write<T, E: From<AuthorizationServerError>>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut conn = self.connection()?;
        let sqlite: &mut SqliteConnection = &mut conn;
        sqlite
            .immediate_transaction(|conn| {
                f(&mut SqliteGrantTx { conn }).map_err(ScopeError::Closure)
            })
            .map_err(|error| match error {
                ScopeError::Closure(error) => error,
                ScopeError::Transaction(error) => {
                    E::from(AuthorizationServerError::infrastructure(
                        "grant store transaction failed",
                        error,
                    ))
                }
            })
    }
}

/// How a write scope failed: its closure's own error, or diesel's `BEGIN`,
/// `COMMIT` or `ROLLBACK` — which diesel's transaction runner needs a
/// `From<diesel::result::Error>` for, whatever error the closure speaks.
enum ScopeError<E> {
    Closure(E),
    Transaction(diesel::result::Error),
}

impl<E> From<diesel::result::Error> for ScopeError<E> {
    fn from(error: diesel::result::Error) -> Self {
        ScopeError::Transaction(error)
    }
}

#[cfg(test)]
mod tests {
    use diesel::migration::{Migration, MigrationSource, MigrationVersion};
    use diesel::prelude::*;
    use diesel::sqlite::{Sqlite, SqliteConnection};

    use super::{MIGRATIONS, MIGRATION_NAMESPACE};
    use crate::db::SqliteGrantStore;
    use crate::domain::grant_store::SigningKeysTx as _;
    use crate::domain::GrantStore as _;

    #[derive(QueryableByName)]
    struct Name {
        #[diesel(sql_type = diesel::sql_types::Text)]
        name: String,
    }

    /// A nullable column read under the alias `name`.
    #[derive(QueryableByName)]
    struct OptionalName {
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
        name: Option<String>,
    }

    /// [`MIGRATIONS`] narrowed to the versions at or below `.0` — it drives a
    /// database to the state an install was in *before* a later migration ran,
    /// so a test can observe what that migration actually changes. Mirrors the
    /// harness of the same name in `apps-rust`'s `db/apps_store.rs`.
    struct MigrationsThrough(&'static str);

    impl MigrationSource<Sqlite> for MigrationsThrough {
        fn migrations(&self) -> diesel::migration::Result<Vec<Box<dyn Migration<Sqlite>>>> {
            let mut migrations = MIGRATIONS.migrations()?;
            let last = MigrationVersion::from(self.0);
            migrations.retain(|m| m.name().version() <= last);
            Ok(migrations)
        }
    }

    /// The regression `0010_ohif_viewer_client_fhir_viewer_redirect` exists for:
    /// migrations are run-once, so an install that already applied `0009` never
    /// re-reads it. Editing `0009`'s `redirect_uris` in place would have left
    /// every upgraded install on the published directory URL, and `/authorize`
    /// matches `redirect_uri` by exact URL equality — so the `/fhir-viewer`
    /// launch would fail there. A fresh open applies both migrations and cannot
    /// tell the two apart; driving a database to `0009` first is the only way to
    /// observe it.
    #[test]
    fn an_install_already_at_0009_is_upgraded_onto_the_fhir_viewer_redirect() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0009"),
        )
        .expect("migrate to 0009");

        let seeded: Vec<Name> =
            diesel::sql_query("SELECT redirect_uris AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("ohif-viewer")
                .load(&mut conn)
                .expect("0009 must have seeded the ohif-viewer client");
        assert_eq!(
            seeded[0].name, r#"["/","https://wildflowerhealth.io/ohif-viewer/"]"#,
            "0009 must stay exactly as it shipped — an install that ran it sees no edit",
        );

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0010"),
        )
        .expect("upgrade through 0010");

        let upgraded: Vec<Name> =
            diesel::sql_query("SELECT redirect_uris AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("ohif-viewer")
                .load(&mut conn)
                .expect("the client row must survive the upgrade");
        assert_eq!(
            upgraded[0].name,
            r#"["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
        );
    }

    /// [`MIGRATIONS`] through `0009`, keeping only the one `0009` directory named
    /// `.0` — an install that opened while that was the only `0009`. Two
    /// directories share that version and the runner keys applied migrations by
    /// version alone, so such an install recorded `0009` and never runs the
    /// other one (the gap `0015` / `0016` repair).
    struct MigrationsThroughOnly0009(&'static str);

    impl MigrationSource<Sqlite> for MigrationsThroughOnly0009 {
        fn migrations(&self) -> diesel::migration::Result<Vec<Box<dyn Migration<Sqlite>>>> {
            let mut migrations = MIGRATIONS.migrations()?;
            let version_0009 = MigrationVersion::from("0009");
            migrations
                .retain(|m| m.name().version() < version_0009 || m.name().to_string() == self.0);
            // A name that matches no directory would run no `0009` at all, and
            // the full upgrade would then run both — passing the regression
            // tests with or without the repairs.
            assert_eq!(
                migrations
                    .iter()
                    .filter(|m| m.name().version() == version_0009)
                    .count(),
                1,
                "{} must name exactly one `0009` migration",
                self.0,
            );
            Ok(migrations)
        }
    }

    fn column_for_client(conn: &mut SqliteConnection, column: &str, client_id: &str) -> Vec<Name> {
        diesel::sql_query(format!(
            "SELECT {column} AS name FROM clients WHERE client_id = ?"
        ))
        .bind::<diesel::sql_types::Text, _>(client_id)
        .load(conn)
        .expect("query clients")
    }

    /// The regression `0015_repair_importer_client_write_scopes` exists for: an
    /// install that ran only `0009_seed_ohif_viewer_client` (it landed first)
    /// skipped `0009_widen_importer_client_write_scopes`, and kept the `0008`
    /// scope set. Upgrading it must widen the Importer's scopes to `0009`'s set.
    #[test]
    fn an_install_that_ran_only_the_ohif_0009_gains_the_importer_write_scopes() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThroughOnly0009("0009_seed_ohif_viewer_client"),
        )
        .expect("migrate to the OHIF 0009 alone");
        assert_eq!(
            column_for_client(&mut conn, "allowed_scopes", "importer-app")[0].name,
            r#"["launch","openid","fhirUser","system/DocumentReference.rs","system/DocumentReference.u","system/Patient.u","system/Observation.u"]"#,
            "the importer widening was skipped, leaving 0008's set",
        );

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0015"),
        )
        .expect("upgrade through 0015");

        assert_eq!(
            column_for_client(&mut conn, "allowed_scopes", "importer-app")[0].name,
            r#"["launch","openid","fhirUser","system/DocumentReference.cruds","system/Patient.cruds","system/Observation.cruds","system/Practitioner.cruds","system/DiagnosticReport.cruds","system/Medication.cruds","system/MedicationRequest.cruds","system/MedicationDispense.cruds","system/ServiceRequest.cruds","system/ImagingStudy.cruds"]"#,
        );
    }

    /// The regression `0016_repair_ohif_viewer_client` exists for: an install
    /// that ran only `0009_widen_importer_client_write_scopes` has no
    /// `ohif-viewer` client, so `0010`'s redirect update matched nothing.
    /// Upgrading it must seed the client in the `0009` + `0010` end state.
    #[test]
    fn an_install_that_ran_only_the_importer_0009_gains_the_ohif_viewer_client() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThroughOnly0009("0009_widen_importer_client_write_scopes"),
        )
        .expect("migrate to the importer 0009 alone");
        assert!(
            column_for_client(&mut conn, "client_id", "ohif-viewer").is_empty(),
            "the OHIF seed was skipped",
        );

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0016"),
        )
        .expect("upgrade through 0016");

        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", "ohif-viewer")[0].name,
            r#"["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
        );
        assert_eq!(
            column_for_client(&mut conn, "allowed_scopes", "ohif-viewer")[0].name,
            r#"["launch","openid","fhirUser","system/Patient.rs","system/ImagingStudy.rs","system/DocumentReference.rs"]"#,
        );
    }

    /// The repairs leave a row alone once it has changed from the state they
    /// fix: an Importer client whose scopes were changed after `0009` is not
    /// reset to `0009`'s set, and an existing `ohif-viewer` row is not
    /// touched.
    #[test]
    fn the_0009_repairs_leave_changed_rows_alone() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0013"),
        )
        .expect("migrate to 0013");
        diesel::sql_query(
            "UPDATE clients SET allowed_scopes = '[\"launch\"]' \
             WHERE client_id IN ('importer-app', 'ohif-viewer')",
        )
        .execute(&mut conn)
        .expect("change both rows");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0016"),
        )
        .expect("upgrade through the repairs");

        for client_id in ["importer-app", "ohif-viewer"] {
            assert_eq!(
                column_for_client(&mut conn, "allowed_scopes", client_id)[0].name,
                r#"["launch"]"#,
                "{client_id} must be left as it was",
            );
        }
    }

    /// Every migration has a version of its own, apart from the historical
    /// `0009` pair (left as it shipped; `0015` / `0016` repair it). The runner
    /// records applied migrations by version alone, so a second directory
    /// under a version an install has already applied is silently skipped
    /// there — while a fresh database runs it, so no other test notices.
    #[test]
    fn migration_versions_are_unique_apart_from_the_historical_0009_pair() {
        let mut names_by_version = std::collections::BTreeMap::<String, Vec<String>>::new();
        for migration in
            MigrationSource::<Sqlite>::migrations(&MIGRATIONS).expect("load migrations")
        {
            names_by_version
                .entry(migration.name().version().to_string())
                .or_default()
                .push(migration.name().to_string());
        }
        let mut shared: Vec<(String, Vec<String>)> = names_by_version
            .into_iter()
            .filter(|(_, names)| names.len() > 1)
            .collect();
        for (_, names) in &mut shared {
            names.sort();
        }
        assert_eq!(
            shared,
            vec![(
                "0009".to_owned(),
                vec![
                    "0009_seed_ohif_viewer_client".to_owned(),
                    "0009_widen_importer_client_write_scopes".to_owned(),
                ],
            )],
            "give each new migration a version no other migration uses",
        );
    }

    /// A new seed reaches an install that already ran every earlier migration:
    /// driving a database through `0018` and then opening it with the full set
    /// must add the `lifting-app` client (`0019`) with its exact redirect URIs
    /// and scope set — the upgrade path a fresh open cannot distinguish from a
    /// first run.
    #[test]
    fn an_install_already_at_0018_gains_the_lifting_app_client() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0018"),
        )
        .expect("migrate to 0018");

        let before: Vec<Name> =
            diesel::sql_query("SELECT client_id AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("lifting-app")
                .load(&mut conn)
                .expect("query clients");
        assert!(
            before.is_empty(),
            "no migration through 0018 seeds lifting-app"
        );

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0019"),
        )
        .expect("upgrade through 0019");

        let redirects: Vec<Name> =
            diesel::sql_query("SELECT redirect_uris AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("lifting-app")
                .load(&mut conn)
                .expect("0019 must seed the lifting-app client");
        assert_eq!(
            redirects[0].name,
            r#"["/","https://wildflowerhealth.io/lifting-app/"]"#,
        );
        let scopes: Vec<Name> =
            diesel::sql_query("SELECT allowed_scopes AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>("lifting-app")
                .load(&mut conn)
                .expect("query scopes");
        assert_eq!(
            scopes[0].name,
            r#"["launch","launch/patient","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]"#,
        );
    }

    /// The scopes a client allows, as its stored JSON array.
    fn allowed_scopes_of(conn: &mut SqliteConnection, client_id: &str) -> String {
        let scopes: Vec<Name> =
            diesel::sql_query("SELECT allowed_scopes AS name FROM clients WHERE client_id = ?")
                .bind::<diesel::sql_types::Text, _>(client_id)
                .load(conn)
                .expect("query scopes");
        scopes
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("{client_id} is seeded"))
            .name
    }

    /// An install already at `0019` — Medications and Lifting allowing
    /// `launch/patient` — is moved by `0020` onto the in-app patient pick: both
    /// clients lose `launch/patient`, and Medications gains `system/Patient.rs`
    /// for its picker. Reverting `0020` restores what `0019` left.
    #[test]
    fn an_install_already_at_0019_drops_launch_patient_from_the_app_clients() {
        const MEDICATIONS_AT_0019: &str = r#"["launch","launch/patient","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs"]"#;
        const LIFTING_AT_0019: &str = r#"["launch","launch/patient","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]"#;

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0019"),
        )
        .expect("migrate to 0019");
        assert_eq!(
            allowed_scopes_of(&mut conn, "medications-app"),
            MEDICATIONS_AT_0019
        );
        assert_eq!(allowed_scopes_of(&mut conn, "lifting-app"), LIFTING_AT_0019);

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0020"),
        )
        .expect("upgrade through 0020");
        assert_eq!(
            allowed_scopes_of(&mut conn, "medications-app"),
            r#"["launch","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs","system/Patient.rs"]"#,
        );
        assert_eq!(
            allowed_scopes_of(&mut conn, "lifting-app"),
            r#"["launch","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]"#,
        );

        let migration_0020 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0020"))
            .expect("0020 is embedded");
        migration_0020.revert(&mut conn).expect("revert 0020");
        assert_eq!(
            allowed_scopes_of(&mut conn, "medications-app"),
            MEDICATIONS_AT_0019
        );
        assert_eq!(allowed_scopes_of(&mut conn, "lifting-app"), LIFTING_AT_0019);
    }

    /// An install already at `0020` — each seeded first-party client holding a
    /// `"/"` path entry ahead of its absolute redirect — is moved by `0021` onto
    /// absolute entries only: every path entry is gone, the absolute ones keep
    /// their order, a row with no path entry is left untouched, and every row
    /// decodes as a [`Client`](crate::domain::client::Client).
    #[test]
    fn an_install_already_at_0020_drops_path_entries_from_redirect_uris() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0020"),
        )
        .expect("migrate to 0020");
        let redirect_uris_of = |conn: &mut SqliteConnection, client_id: &str| {
            column_for_client(conn, "redirect_uris", client_id)[0]
                .name
                .clone()
        };
        for (client_id, at_0020) in [
            (
                "medications-app",
                r#"["/","https://wildflowerhealth.io/medications-app/"]"#,
            ),
            (
                "web-trace-app",
                r#"["/","https://wildflowerhealth.io/web-trace-app/"]"#,
            ),
            (
                "importer-app",
                r#"["/","https://wildflowerhealth.io/importer-app/"]"#,
            ),
            (
                "ohif-viewer",
                r#"["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
            ),
            (
                "lifting-app",
                r#"["/","https://wildflowerhealth.io/lifting-app/"]"#,
            ),
        ] {
            assert_eq!(redirect_uris_of(&mut conn, client_id), at_0020);
        }
        // A path entry between two absolute ones, so the rebuilt array must
        // keep the absolute entries in their original order.
        diesel::sql_query(
            "UPDATE clients SET redirect_uris = \
             '[\"https://b.example/cb\",\"/nested/\",\"https://a.example/cb\"]' \
             WHERE client_id = 'web-trace-app'",
        )
        .execute(&mut conn)
        .expect("plant an interleaved path entry");
        let docs_at_0020 = redirect_uris_of(&mut conn, "wildflower-server-docs");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0021"),
        )
        .expect("upgrade through 0021");

        for (client_id, after) in [
            (
                "medications-app",
                r#"["https://wildflowerhealth.io/medications-app/"]"#,
            ),
            (
                "web-trace-app",
                r#"["https://b.example/cb","https://a.example/cb"]"#,
            ),
            (
                "importer-app",
                r#"["https://wildflowerhealth.io/importer-app/"]"#,
            ),
            (
                "ohif-viewer",
                r#"["https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
            ),
            (
                "lifting-app",
                r#"["https://wildflowerhealth.io/lifting-app/"]"#,
            ),
        ] {
            assert_eq!(redirect_uris_of(&mut conn, client_id), after);
        }
        assert_eq!(
            redirect_uris_of(&mut conn, "wildflower-server-docs"),
            docs_at_0020,
            "a row with no path entry is left untouched",
        );
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("upgrade through the rest");
        let clients: Vec<crate::domain::client::Client> = crate::db::clients::clients::table
            .select(crate::domain::client::Client::as_select())
            .load(&mut conn)
            .expect("every migrated row decodes as a Client");
        assert!(!clients.is_empty());
    }

    /// A new seed reaches an install that already ran every earlier migration:
    /// driving a database through `0021` and then opening it with the full set
    /// must add the `health-viewer-app` client (`0022`) with its exact redirect
    /// URIs and scope set.
    #[test]
    fn an_install_already_at_0021_gains_the_health_viewer_app_client() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0021"),
        )
        .expect("migrate to 0021");
        assert!(
            column_for_client(&mut conn, "client_id", "health-viewer-app").is_empty(),
            "no migration through 0021 seeds health-viewer-app"
        );

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0022"),
        )
        .expect("upgrade through 0022");

        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", "health-viewer-app")[0].name,
            r#"["https://wildflowerhealth.io/health-viewer-app/"]"#,
        );
        assert_eq!(
            allowed_scopes_of(&mut conn, "health-viewer-app"),
            r#"["launch","openid","fhirUser","system/Observation.rs","system/MedicationRequest.rs","system/Patient.rs"]"#,
        );
    }

    /// An install already at `0023`, holding a launch context, is moved by
    /// `0024` onto a nullable `client_id`: the row survives intact, a launch for
    /// any client (NULL client) can then be stored, and the table refuses a
    /// patient on a launch with no client.
    #[test]
    fn an_install_already_at_0023_keeps_its_launches_and_admits_any_client() {
        use diesel::connection::SimpleConnection as _;

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0023"),
        )
        .expect("migrate to 0023");
        conn.batch_execute(
            "INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
             VALUES ('bound', 'app', 'pat-1', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
        )
        .expect("a launch at 0023");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("upgrade through 0024");

        let kept: Vec<Name> = diesel::sql_query(
            "SELECT client_id || ':' || patient AS name FROM launch_contexts WHERE nonce = 'bound'",
        )
        .load(&mut conn)
        .expect("read the kept launch");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].name, "app:pat-1");
        conn.batch_execute(
            "INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
             VALUES ('any', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
        )
        .expect("a launch for any client is stored");
        assert!(
            conn.batch_execute(
                "INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
                 VALUES ('bad', NULL, 'pat-1', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
            )
            .is_err(),
            "a patient needs a client"
        );
    }

    /// An install already at `0024` re-keys Lifting's clients when `0025` runs:
    /// the production client and a debug build's dev client take their random
    /// ids, the production redirect moves to `/lifting/`, what was issued to
    /// them (here a launch) follows, and reverting `0025` restores `0019`'s ids.
    #[test]
    fn an_install_already_at_0024_rekeys_the_lifting_clients() {
        use diesel::connection::SimpleConnection as _;
        const STRENGTH: &str = "bdf9fc5cb5a28c6683b49896b0ef8a75";
        const STRENGTH_DEV: &str = "8467e680a05f1e92e22864e923144e5a";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0024"),
        )
        .expect("migrate to 0024");
        conn.batch_execute(
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('lifting-app-dev', 'Lifting (Dev)', 'public', \
                     '[\"http://localhost:5199/\"]', '[\"launch\"]', \
                     '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL); \
             INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
             VALUES ('issued', 'lifting-app', 'pat-1', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
        )
        .expect("a dev client and a launch at 0024");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0025"),
        )
        .expect("upgrade through 0025");

        assert!(column_for_client(&mut conn, "client_id", "lifting-app").is_empty());
        assert!(column_for_client(&mut conn, "client_id", "lifting-app-dev").is_empty());
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", STRENGTH)[0].name,
            r#"["https://wildflowerhealth.io/lifting/"]"#,
        );
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", STRENGTH_DEV)[0].name,
            r#"["http://localhost:5199/"]"#,
        );
        let launch: Vec<Name> = diesel::sql_query(
            "SELECT client_id AS name FROM launch_contexts WHERE nonce = 'issued'",
        )
        .load(&mut conn)
        .expect("read the launch");
        assert_eq!(launch[0].name, STRENGTH);

        let migration_0025 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0025"))
            .expect("0025 is embedded");
        migration_0025.revert(&mut conn).expect("revert 0025");
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", "lifting-app")[0].name,
            r#"["https://wildflowerhealth.io/lifting-app/"]"#,
        );
        assert_eq!(
            column_for_client(&mut conn, "client_id", "lifting-app-dev").len(),
            1
        );
    }

    /// An install already at `0027` re-keys the site's clients when `0028` runs:
    /// each production client takes its random id and its redirect moves to the
    /// product's path, each dev client takes its random id, what was issued to
    /// them (here a launch) follows, and the Synthetic Data Loader gains a
    /// production client. Reverting `0028` restores the old ids and paths and
    /// removes that client.
    #[test]
    fn an_install_already_at_0027_rekeys_the_site_app_clients() {
        use diesel::connection::SimpleConnection as _;
        const SYNTHETIC_DATA: &str = "225ba6af034a3acec6be7ff8010df67f";
        // (old id, new id, the redirect it holds after `0028`).
        let production = [
            (
                "medications-app",
                "9769f8b274370708d0d3ebb2e3e59b7c",
                r#"["https://wildflowerhealth.io/medications/"]"#,
            ),
            (
                "importer-app",
                "165cd26573e5ac72378e6ad2d2198330",
                r#"["https://wildflowerhealth.io/importer/"]"#,
            ),
            (
                "health-viewer-app",
                "474e103de61f9141c4b640d59bfa130e",
                r#"["https://wildflowerhealth.io/health-viewer/"]"#,
            ),
            (
                "wildflower-server-docs",
                "664a01e8614050cd82ffe90350b81413",
                r#"["https://wildflowerhealth.io/server-docs/"]"#,
            ),
        ];
        let dev = [
            ("medications-app-dev", "4be2ee91360733fdcb99b43a3822de5f"),
            ("importer-app-dev", "57268ff88aea38d6a22de56ae53e2c28"),
            ("health-viewer-app-dev", "e7efc7c805f5f8f640bb3b3d48a2d7aa"),
            ("synthetic-data-app-dev", "07a31e58db3367afda5c6480e03ed993"),
        ];

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0027"),
        )
        .expect("migrate to 0027");
        let redirects_at_0027: Vec<String> = production
            .iter()
            .map(|(old, _, _)| {
                column_for_client(&mut conn, "redirect_uris", old)[0]
                    .name
                    .clone()
            })
            .collect();
        for (old, _) in dev {
            conn.batch_execute(&format!(
                "INSERT INTO clients \
                 (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
                  secret_hash, registered_at, disabled_at) \
                 VALUES ('{old}', 'A (Dev)', 'public', '[\"http://localhost:5190/\"]', \
                         '[\"launch\"]', '[\"authorization_code\"]', NULL, \
                         '2024-01-01 00:00:00+00:00', NULL)"
            ))
            .expect("a dev client at 0027");
        }
        conn.batch_execute(
            "INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
             VALUES ('issued', 'importer-app', 'pat-1', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
        )
        .expect("a launch at 0027");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0028"),
        )
        .expect("upgrade through 0028");

        for (old, new, redirects) in production {
            assert!(column_for_client(&mut conn, "client_id", old).is_empty());
            assert_eq!(
                column_for_client(&mut conn, "redirect_uris", new)[0].name,
                redirects,
            );
        }
        for (old, new) in dev {
            assert!(column_for_client(&mut conn, "client_id", old).is_empty());
            assert_eq!(
                column_for_client(&mut conn, "redirect_uris", new)[0].name,
                r#"["http://localhost:5190/"]"#,
            );
        }
        let launch: Vec<Name> = diesel::sql_query(
            "SELECT client_id AS name FROM launch_contexts WHERE nonce = 'issued'",
        )
        .load(&mut conn)
        .expect("read the launch");
        assert_eq!(launch[0].name, "165cd26573e5ac72378e6ad2d2198330");
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", SYNTHETIC_DATA)[0].name,
            r#"["https://wildflowerhealth.io/synthetic-data/"]"#,
        );

        let migration_0028 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0028"))
            .expect("0028 is embedded");
        migration_0028.revert(&mut conn).expect("revert 0028");
        for ((old, _, _), at_0027) in production.iter().zip(&redirects_at_0027) {
            assert_eq!(
                &column_for_client(&mut conn, "redirect_uris", old)[0].name,
                at_0027,
            );
        }
        for (old, _) in dev {
            assert_eq!(column_for_client(&mut conn, "client_id", old).len(), 1);
        }
        assert!(column_for_client(&mut conn, "client_id", SYNTHETIC_DATA).is_empty());
    }

    /// An install already at `0028` re-keys the OHIF viewer's clients when
    /// `0029` runs: the production client and a debug build's dev client take
    /// their random ids and keep their redirects, and what was issued to them
    /// (here a launch) follows. Reverting `0029` restores the old ids.
    #[test]
    fn an_install_already_at_0028_rekeys_the_ohif_viewer_clients() {
        use diesel::connection::SimpleConnection as _;
        const OHIF_VIEWER: &str = "941de68e6b59eb9dcc32df8ede89e636";
        const OHIF_VIEWER_DEV: &str = "f9866f7b1d0d8505dc65ef4f749664b5";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0028"),
        )
        .expect("migrate to 0028");
        conn.batch_execute(
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('ohif-viewer-dev', 'Imaging (Dev)', 'public', \
                     '[\"http://localhost:5194/fhir-viewer\"]', '[\"launch\"]', \
                     '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL); \
             INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
             VALUES ('issued', 'ohif-viewer', 'pat-1', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
        )
        .expect("a dev client and a launch at 0028");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0029"),
        )
        .expect("upgrade through 0029");

        assert!(column_for_client(&mut conn, "client_id", "ohif-viewer").is_empty());
        assert!(column_for_client(&mut conn, "client_id", "ohif-viewer-dev").is_empty());
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", OHIF_VIEWER)[0].name,
            r#"["https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
        );
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", OHIF_VIEWER_DEV)[0].name,
            r#"["http://localhost:5194/fhir-viewer"]"#,
        );
        let launch: Vec<Name> = diesel::sql_query(
            "SELECT client_id AS name FROM launch_contexts WHERE nonce = 'issued'",
        )
        .load(&mut conn)
        .expect("read the launch");
        assert_eq!(launch[0].name, OHIF_VIEWER);

        let migration_0029 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0029"))
            .expect("0029 is embedded");
        migration_0029.revert(&mut conn).expect("revert 0029");
        for client_id in ["ohif-viewer", "ohif-viewer-dev"] {
            assert_eq!(
                column_for_client(&mut conn, "client_id", client_id).len(),
                1
            );
        }
        assert!(column_for_client(&mut conn, "client_id", OHIF_VIEWER).is_empty());
    }

    /// An install already at `0029` re-keys FHIR Sync for Pebble's clients when
    /// `0030` runs: the production client and a debug build's dev client take
    /// their random ids and keep their redirects, and what was issued to them
    /// (here a launch) follows. Reverting `0030` restores the old ids.
    #[test]
    fn an_install_already_at_0029_rekeys_the_fhir_sync_pebble_clients() {
        use diesel::connection::SimpleConnection as _;
        const FHIR_SYNC_PEBBLE: &str = "6847df97d54c31936d54ca1b36b3bb09";
        const FHIR_SYNC_PEBBLE_DEV: &str = "61e195d6b08bab6bf2cedb1ef3831fa7";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0029"),
        )
        .expect("migrate to 0029");
        conn.batch_execute(
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('fhir-sync-pebble-dev', 'FHIR Sync for Pebble (Dev)', 'public', \
                     '[\"http://localhost:5195/\"]', '[\"openid\"]', \
                     '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL); \
             INSERT INTO launch_contexts (nonce, client_id, patient, created_at, expires_at) \
             VALUES ('issued', 'fhir-sync-pebble', 'pat-1', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z')",
        )
        .expect("a dev client and a launch at 0029");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0030"),
        )
        .expect("upgrade through 0030");

        assert!(column_for_client(&mut conn, "client_id", "fhir-sync-pebble").is_empty());
        assert!(column_for_client(&mut conn, "client_id", "fhir-sync-pebble-dev").is_empty());
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", FHIR_SYNC_PEBBLE)[0].name,
            r#"["https://wildflowerhealth.io/fhir-sync-pebble/"]"#,
        );
        assert_eq!(
            column_for_client(&mut conn, "redirect_uris", FHIR_SYNC_PEBBLE_DEV)[0].name,
            r#"["http://localhost:5195/"]"#,
        );
        let launch: Vec<Name> = diesel::sql_query(
            "SELECT client_id AS name FROM launch_contexts WHERE nonce = 'issued'",
        )
        .load(&mut conn)
        .expect("read the launch");
        assert_eq!(launch[0].name, FHIR_SYNC_PEBBLE);

        let migration_0030 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0030"))
            .expect("0030 is embedded");
        migration_0030.revert(&mut conn).expect("revert 0030");
        for client_id in ["fhir-sync-pebble", "fhir-sync-pebble-dev"] {
            assert_eq!(
                column_for_client(&mut conn, "client_id", client_id).len(),
                1
            );
        }
        assert!(column_for_client(&mut conn, "client_id", FHIR_SYNC_PEBBLE).is_empty());
    }

    /// An install already at `0031` — the launcher's client allowing `0012`'s
    /// maximal vocabulary — is narrowed by `0032` to the scopes the launcher
    /// asks for. Reverting `0032` restores what `0031` left.
    #[test]
    fn an_install_already_at_0031_narrows_the_launcher_client() {
        const LAUNCHER: &str = "03a513940b52f8c2649a5366d1a26d19";
        const LAUNCHER_AT_0031: &str = r#"["openid","profile","fhirUser","launch","launch/patient","offline_access","wildflower/launch","system/*.cruds","wildflower/*.cruds"]"#;

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0031"),
        )
        .expect("migrate to 0031");
        assert_eq!(allowed_scopes_of(&mut conn, LAUNCHER), LAUNCHER_AT_0031);

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0032"),
        )
        .expect("upgrade through 0032");
        assert_eq!(
            allowed_scopes_of(&mut conn, LAUNCHER),
            r#"["launch","launch/patient","wildflower/launch","system/*.cruds","wildflower/*.cruds"]"#,
        );

        let migration_0032 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0032"))
            .expect("0032 is embedded");
        migration_0032.revert(&mut conn).expect("revert 0032");
        assert_eq!(allowed_scopes_of(&mut conn, LAUNCHER), LAUNCHER_AT_0031);
    }

    /// An install already at `0031`, holding the host app's client under its
    /// old `wildflower-host` id and a grant of it, re-keys both when `0033`
    /// runs: no `wildflower-host` row lingers beside the one seeding upserts.
    /// Reverting `0033` restores the old id.
    #[test]
    fn an_install_already_at_0031_rekeys_the_host_app_client() {
        use diesel::connection::SimpleConnection as _;
        const HOST_APP: &str = "c4e755b6a4c1abf2aae6d0d83f2545a5";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0031"),
        )
        .expect("migrate to 0031");
        conn.batch_execute(
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('wildflower-host', 'Wildflower (host)', 'public', '[]', \
                     '[\"system/*.cruds\"]', '[\"device_code\"]', NULL, \
                     '2024-01-01 00:00:00+00:00', NULL); \
             INSERT INTO device_grants \
             (id, client_id, scopes, granted_at, last_used_at, patient, device_name) \
             VALUES ('host-grant', 'wildflower-host', '[\"system/*.cruds\"]', \
                     '2026-01-01T00:00:00Z', NULL, NULL, 'The Owner''s laptop')",
        )
        .expect("the host app's client and a grant at 0031");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("upgrade through 0033");

        assert!(column_for_client(&mut conn, "client_id", "wildflower-host").is_empty());
        assert_eq!(
            column_for_client(&mut conn, "name", HOST_APP)[0].name,
            "Wildflower Host"
        );
        let grant: Vec<Name> = diesel::sql_query(
            "SELECT client_id AS name FROM device_grants WHERE id = 'host-grant'",
        )
        .load(&mut conn)
        .expect("read the grant");
        assert_eq!(grant[0].name, HOST_APP);

        let migration_0033 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0033"))
            .expect("0033 is embedded");
        migration_0033.revert(&mut conn).expect("revert 0033");
        assert_eq!(
            column_for_client(&mut conn, "client_id", "wildflower-host").len(),
            1
        );
        assert!(column_for_client(&mut conn, "client_id", HOST_APP).is_empty());
    }

    /// An install already at `0034` renames the Plots and Strength clients
    /// when `0035` runs: each client still holding its seeded name takes its
    /// product's, and one whose name is anything else keeps it. Reverting
    /// `0035` restores the seeded names.
    #[test]
    fn an_install_already_at_0034_renames_the_plots_and_strength_clients() {
        use diesel::connection::SimpleConnection as _;
        const PLOTS: &str = "474e103de61f9141c4b640d59bfa130e";
        const PLOTS_DEV: &str = "e7efc7c805f5f8f640bb3b3d48a2d7aa";
        const STRENGTH: &str = "bdf9fc5cb5a28c6683b49896b0ef8a75";
        const STRENGTH_DEV: &str = "8467e680a05f1e92e22864e923144e5a";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0034"),
        )
        .expect("migrate to 0034");
        conn.batch_execute(
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('e7efc7c805f5f8f640bb3b3d48a2d7aa', 'Health Viewer (Dev)', 'public', \
                     '[\"http://localhost:5196/\"]', '[\"launch\"]', \
                     '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL), \
                    ('8467e680a05f1e92e22864e923144e5a', 'My lifts', 'public', \
                     '[\"http://localhost:5199/\"]', '[\"launch\"]', \
                     '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL)",
        )
        .expect("the dev clients at 0034, Strength's under another name");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0035"),
        )
        .expect("upgrade through 0035");

        let name_of = |conn: &mut SqliteConnection, client_id: &str| {
            column_for_client(conn, "name", client_id)[0].name.clone()
        };
        assert_eq!(name_of(&mut conn, PLOTS), "Plots");
        assert_eq!(name_of(&mut conn, PLOTS_DEV), "Plots (Dev)");
        assert_eq!(name_of(&mut conn, STRENGTH), "Strength");
        assert_eq!(name_of(&mut conn, STRENGTH_DEV), "My lifts");

        let migration_0035 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0035"))
            .expect("0035 is embedded");
        migration_0035.revert(&mut conn).expect("revert 0035");
        assert_eq!(name_of(&mut conn, PLOTS), "Synthesized Health Viewer");
        assert_eq!(name_of(&mut conn, PLOTS_DEV), "Health Viewer (Dev)");
        assert_eq!(name_of(&mut conn, STRENGTH), "Lifting");
        assert_eq!(name_of(&mut conn, STRENGTH_DEV), "My lifts");
    }

    /// An install already at `0036` gains each hosted app's own origin as a
    /// redirect when `0037` runs, in front of the redirect on
    /// `wildflowerhealth.io` it held; a client whose list the Owner changed
    /// keeps it. Reverting `0037` restores the lists.
    #[test]
    fn an_install_already_at_0036_adds_the_app_origin_redirects() {
        use diesel::connection::SimpleConnection as _;
        const MEDICATIONS: &str = "9769f8b274370708d0d3ebb2e3e59b7c";
        const OHIF_VIEWER: &str = "941de68e6b59eb9dcc32df8ede89e636";
        const LAUNCHER: &str = "03a513940b52f8c2649a5366d1a26d19";
        const STRENGTH: &str = "bdf9fc5cb5a28c6683b49896b0ef8a75";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0036"),
        )
        .expect("migrate to 0036");
        conn.batch_execute(&format!(
            "UPDATE clients SET redirect_uris = '[\"https://lifts.example/\"]' \
             WHERE client_id = '{STRENGTH}'"
        ))
        .expect("Strength's redirects changed by the Owner at 0036");
        let redirects_of = |conn: &mut SqliteConnection, client_id: &str| {
            column_for_client(conn, "redirect_uris", client_id)[0]
                .name
                .clone()
        };
        let at_0036 = [MEDICATIONS, OHIF_VIEWER, LAUNCHER, STRENGTH]
            .map(|client_id| redirects_of(&mut conn, client_id));

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0037"),
        )
        .expect("upgrade through 0037");

        assert_eq!(
            redirects_of(&mut conn, MEDICATIONS),
            r#"["https://medications.wildflowerhealth.io/","https://wildflowerhealth.io/medications/"]"#,
        );
        assert_eq!(
            redirects_of(&mut conn, OHIF_VIEWER),
            r#"["https://ohif-viewer.wildflowerhealth.io/fhir-viewer","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]"#,
        );
        assert_eq!(
            redirects_of(&mut conn, LAUNCHER),
            r#"["https://launcher.wildflowerhealth.io/","https://wildflowerhealth.io/launcher/"]"#,
        );
        assert_eq!(
            redirects_of(&mut conn, STRENGTH),
            r#"["https://lifts.example/"]"#
        );

        let migration_0037 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0037"))
            .expect("0037 is embedded");
        migration_0037.revert(&mut conn).expect("revert 0037");
        let reverted = [MEDICATIONS, OHIF_VIEWER, LAUNCHER, STRENGTH]
            .map(|client_id| redirects_of(&mut conn, client_id));
        assert_eq!(reverted, at_0036);
    }

    /// An install already at `0037`, holding the browser-session client under
    /// its old `wildflower-owner-browser` id and a row naming it in every table
    /// that names a client, re-keys them all when `0038` runs, and every
    /// standing same-device session ends, so the Owner signs in again; one already
    /// revoked keeps its time, and a paired browser's session stands. The
    /// request column takes its new name. Reverting `0038` restores the old id
    /// and column name.
    #[test]
    fn an_install_already_at_0037_rekeys_the_browser_session_client_and_ends_owner_sessions() {
        use diesel::connection::SimpleConnection as _;
        const BROWSERS: &str = "cb9bbe139845cae9654b7909d60d274f";
        const OLD_ID: &str = "wildflower-owner-browser";
        const REVOKED_AT: &str = "2026-10-01 00:00:00+00:00";
        /// Each table that names a client, with the key of the row seeded in it.
        const CLIENT_TABLES: [(&str, &str); 6] = [
            ("authorization_requests", "id"),
            ("authorization_codes", "code"),
            ("authorization_code_grants", "id"),
            ("device_grants", "id"),
            ("refresh_token_families", "family_id"),
            ("launch_contexts", "nonce"),
        ];

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0037"),
        )
        .expect("migrate to 0037");
        conn.batch_execute(&format!(
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('{OLD_ID}', 'Wildflower (Owner browsers)', 'public', \
                     '[]', '[\"system/*.cruds\"]', '[]', NULL, \
                     '2024-01-01 00:00:00+00:00', NULL); \
             INSERT INTO authorization_requests \
             (id, grant_type, client_id, requested_scopes, requested_at, expires_at, status) \
             VALUES ('browser-row', 'authorization_code', '{OLD_ID}', '[]', \
                     '2026-10-16 00:00:00+00:00', '2026-10-16 00:10:00+00:00', 'pending'); \
             INSERT INTO authorization_codes \
             (code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, \
              issued_at, expires_at, sid) \
             VALUES ('browser-row', 'browser-row', '{OLD_ID}', 'https://example/', \
                     'challenge', '[]', '2026-10-16 00:00:00+00:00', \
                     '2026-10-16 00:01:00+00:00', 'standing'); \
             INSERT INTO authorization_code_grants \
             (id, client_id, scopes, granted_at, redirect_uri) \
             VALUES ('browser-row', '{OLD_ID}', '[]', '2026-10-16T00:00:00Z', \
                     'https://example/'); \
             INSERT INTO device_grants \
             (id, client_id, scopes, granted_at, device_name) \
             VALUES ('browser-row', '{OLD_ID}', '[]', '2026-10-16T00:00:00Z', 'A laptop'); \
             INSERT INTO refresh_token_families \
             (family_id, client_id, scopes, issued_at, expires_at) \
             VALUES ('browser-row', '{OLD_ID}', '[]', '2026-10-16 00:00:00+00:00', \
                     '2026-10-17 00:00:00+00:00'); \
             INSERT INTO launch_contexts (nonce, client_id, created_at, expires_at) \
             VALUES ('browser-row', '{OLD_ID}', '2026-10-16 00:00:00+00:00', \
                     '2026-10-16 00:10:00+00:00'); \
             INSERT INTO browser_sessions \
             (sid, kind, name, scopes, created_at, expires_at, revoked_at) \
             VALUES ('standing', 'owner', NULL, '[]', '2026-10-16 00:00:00+00:00', \
                     '2026-10-16 08:00:00+00:00', NULL), \
                    ('revoked', 'owner', NULL, '[]', '2026-10-01 00:00:00+00:00', \
                     '2026-10-01 08:00:00+00:00', '{REVOKED_AT}'), \
                    ('approved', 'approved', 'A tablet', '[]', '2026-10-16 00:00:00+00:00', \
                     '2026-11-16 00:00:00+00:00', NULL)"
        ))
        .expect("the browser-session client, a row naming it per table and three sessions at 0037");
        let client_ids_of_seeded_rows = |conn: &mut SqliteConnection| {
            CLIENT_TABLES.map(|(table, key)| {
                diesel::sql_query(format!(
                    "SELECT client_id AS name FROM {table} WHERE {key} = 'browser-row'"
                ))
                .load::<Name>(conn)
                .expect("read the seeded row")
                .remove(0)
                .name
            })
        };

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0038"),
        )
        .expect("upgrade through 0038");

        assert!(column_for_client(&mut conn, "client_id", OLD_ID).is_empty());
        assert_eq!(
            column_for_client(&mut conn, "name", BROWSERS)[0].name,
            "Wildflower Browsers"
        );
        assert_eq!(client_ids_of_seeded_rows(&mut conn), [BROWSERS; 6]);
        let revoked_at_of = |conn: &mut SqliteConnection, sid: &str| {
            diesel::sql_query("SELECT revoked_at AS name FROM browser_sessions WHERE sid = ?")
                .bind::<diesel::sql_types::Text, _>(sid)
                .load::<OptionalName>(conn)
                .expect("read the session")
                .remove(0)
                .name
        };
        let ended_at = revoked_at_of(&mut conn, "standing").expect("the same-device session ended");
        assert!(
            chrono::DateTime::parse_from_str(&ended_at, "%F %T%.f%:z").is_ok(),
            "{ended_at} is in the diesel chrono text encoding"
        );
        assert_eq!(
            revoked_at_of(&mut conn, "revoked").as_deref(),
            Some(REVOKED_AT)
        );
        assert_eq!(revoked_at_of(&mut conn, "approved"), None);
        diesel::sql_query("SELECT decidable_in_requesting_browser FROM authorization_requests")
            .execute(&mut conn)
            .expect("the column has its new name");

        let migration_0038 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0038"))
            .expect("0038 is embedded");
        migration_0038.revert(&mut conn).expect("revert 0038");
        assert_eq!(column_for_client(&mut conn, "client_id", OLD_ID).len(), 1);
        assert!(column_for_client(&mut conn, "client_id", BROWSERS).is_empty());
        assert_eq!(client_ids_of_seeded_rows(&mut conn), [OLD_ID; 6]);
        diesel::sql_query("SELECT requested_by_owner_browser FROM authorization_requests")
            .execute(&mut conn)
            .expect("the column has its old name");
    }

    /// An install already at `0038` renames the Strength clients to
    /// Wildflower Strength when `0039` runs: a client still holding the name
    /// `0035` wrote takes the product's, and one whose name is anything else
    /// keeps it. Reverting `0039` restores the `0035` names.
    #[test]
    fn an_install_already_at_0038_renames_the_strength_clients() {
        use diesel::connection::SimpleConnection as _;
        const STRENGTH: &str = "bdf9fc5cb5a28c6683b49896b0ef8a75";
        const STRENGTH_DEV: &str = "8467e680a05f1e92e22864e923144e5a";

        let name_of = |conn: &mut SqliteConnection, client_id: &str| {
            column_for_client(conn, "name", client_id)[0].name.clone()
        };
        let migration_0039 = || {
            MIGRATIONS
                .migrations()
                .expect("embedded migrations")
                .into_iter()
                .find(|migration| migration.name().version() == MigrationVersion::from("0039"))
                .expect("0039 is embedded")
        };
        for (dev_name, dev_name_after) in [
            ("Strength (Dev)", "Wildflower Strength (Dev)"),
            ("My lifts", "My lifts"),
        ] {
            let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
            wildflowerhealthio_persistence::run_diesel_migrations(
                &mut conn,
                MIGRATION_NAMESPACE,
                MigrationsThrough("0038"),
            )
            .expect("migrate to 0038");
            conn.batch_execute(&format!(
                "INSERT INTO clients \
                 (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
                  secret_hash, registered_at, disabled_at) \
                 VALUES ('{STRENGTH_DEV}', '{dev_name}', 'public', \
                         '[\"http://localhost:5199/\"]', '[\"launch\"]', \
                         '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL)"
            ))
            .expect("the dev client at 0038");
            assert_eq!(name_of(&mut conn, STRENGTH), "Strength");

            wildflowerhealthio_persistence::run_diesel_migrations(
                &mut conn,
                MIGRATION_NAMESPACE,
                MigrationsThrough("0039"),
            )
            .expect("upgrade through 0039");
            assert_eq!(name_of(&mut conn, STRENGTH), "Wildflower Strength");
            assert_eq!(name_of(&mut conn, STRENGTH_DEV), dev_name_after);

            migration_0039().revert(&mut conn).expect("revert 0039");
            assert_eq!(name_of(&mut conn, STRENGTH), "Strength");
            assert_eq!(name_of(&mut conn, STRENGTH_DEV), dev_name);
        }
    }

    /// An install already at `0039` gains `browser_sessions.last_seen_at` when
    /// `0040` runs, each session's backfilled to its `created_at` and the rest
    /// of the row kept, `revoked_at` included. The rebuilt table still takes
    /// only the two kinds. Reverting `0040` drops the column again.
    #[test]
    fn an_install_already_at_0039_backfills_browser_session_last_seen() {
        use diesel::connection::SimpleConnection as _;
        const CREATED_AT: &str = "2026-10-16 00:00:00+00:00";
        const REVOKED_AT: &str = "2026-10-16 01:00:00+00:00";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0039"),
        )
        .expect("migrate to 0039");
        conn.batch_execute(&format!(
            "INSERT INTO browser_sessions \
             (sid, kind, name, scopes, created_at, expires_at, revoked_at) \
             VALUES ('standing', 'owner', NULL, '[\"system/*.cruds\"]', '{CREATED_AT}', \
                     '2026-10-16 08:00:00+00:00', NULL), \
                    ('revoked', 'approved', 'A tablet', '[]', '2026-10-01 00:00:00+00:00', \
                     '2026-11-01 00:00:00+00:00', '{REVOKED_AT}')"
        ))
        .expect("two sessions at 0039");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0040"),
        )
        .expect("upgrade through 0040");

        let column_of = |conn: &mut SqliteConnection, column: &str, sid: &str| {
            diesel::sql_query(format!(
                "SELECT {column} AS name FROM browser_sessions WHERE sid = ?"
            ))
            .bind::<diesel::sql_types::Text, _>(sid)
            .load::<OptionalName>(conn)
            .expect("read the session")
            .remove(0)
            .name
        };
        assert_eq!(
            column_of(&mut conn, "last_seen_at", "standing").as_deref(),
            Some(CREATED_AT)
        );
        assert_eq!(
            column_of(&mut conn, "last_seen_at", "revoked").as_deref(),
            Some("2026-10-01 00:00:00+00:00")
        );
        assert_eq!(
            column_of(&mut conn, "revoked_at", "revoked").as_deref(),
            Some(REVOKED_AT)
        );
        assert_eq!(
            column_of(&mut conn, "name", "revoked").as_deref(),
            Some("A tablet")
        );
        assert!(
            conn.batch_execute(&format!(
                "INSERT INTO browser_sessions \
                 (sid, kind, name, scopes, created_at, expires_at, last_seen_at) \
                 VALUES ('odd', 'other', NULL, '[]', '{CREATED_AT}', '{CREATED_AT}', \
                         '{CREATED_AT}')"
            ))
            .is_err(),
            "the kind CHECK survives the rebuild"
        );

        let migration_0040 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0040"))
            .expect("0040 is embedded");
        migration_0040.revert(&mut conn).expect("revert 0040");
        assert!(
            diesel::sql_query("SELECT last_seen_at FROM browser_sessions")
                .execute(&mut conn)
                .is_err(),
            "the column is gone"
        );
        assert_eq!(
            column_of(&mut conn, "created_at", "standing").as_deref(),
            Some(CREATED_AT)
        );
    }

    /// An install already at `0040` widens Wildflower Authorization's client
    /// to the browser-session scopes when `0041` runs; one whose scopes the
    /// Owner changed keeps them. Reverting `0041` restores `0031`'s set.
    #[test]
    fn an_install_already_at_0040_widens_the_authorization_web_client() {
        use diesel::connection::SimpleConnection as _;
        const AUTHORIZATION_WEB: &str = "7277e898bee8ac81ea44788236e619a5";
        const AT_0040: &str =
            r#"["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d"]"#;
        let migrated_through_0040 = || {
            let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
            wildflowerhealthio_persistence::run_diesel_migrations(
                &mut conn,
                MIGRATION_NAMESPACE,
                MigrationsThrough("0040"),
            )
            .expect("migrate to 0040");
            conn
        };

        let mut conn = migrated_through_0040();
        assert_eq!(allowed_scopes_of(&mut conn, AUTHORIZATION_WEB), AT_0040);
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("upgrade through 0041");
        assert_eq!(
            allowed_scopes_of(&mut conn, AUTHORIZATION_WEB),
            r#"["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d","wildflower/BrowserSession.rd"]"#,
        );
        let migration_0041 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0041"))
            .expect("0041 is embedded");
        migration_0041.revert(&mut conn).expect("revert 0041");
        assert_eq!(allowed_scopes_of(&mut conn, AUTHORIZATION_WEB), AT_0040);

        let mut changed = migrated_through_0040();
        changed
            .batch_execute(&format!(
                "UPDATE clients SET allowed_scopes = '[\"openid\"]' \
                 WHERE client_id = '{AUTHORIZATION_WEB}'"
            ))
            .expect("the Owner changed the scopes at 0040");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut changed,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("upgrade through 0041");
        assert_eq!(
            allowed_scopes_of(&mut changed, AUTHORIZATION_WEB),
            r#"["openid"]"#
        );
    }

    /// An install already at `0041`, holding what the code flow minted with no
    /// browser session, has it ended when `0042` runs: a live sessionless
    /// code-flow family expires now and its unconsumed token is stamped
    /// consumed, a sessionless code is dropped and a sessionless pending
    /// code-flow request expires. A family already dead keeps its times, and a
    /// family made in a session or by the device flow keeps going, as do the
    /// code and requests made in a session or by a device. Reverting `0042`
    /// makes a code's `sid` nullable again.
    #[test]
    fn an_install_already_at_0041_ends_its_sessionless_code_flow() {
        use diesel::connection::SimpleConnection as _;
        const FUTURE: &str = "2999-01-01 00:00:00+00:00";
        const PAST: &str = "2026-01-01 00:00:00+00:00";
        const EARLIER: &str = "2025-12-01 00:00:00+00:00";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0041"),
        )
        .expect("migrate to 0041");
        conn.batch_execute(&format!(
            "INSERT INTO refresh_token_families \
             (family_id, client_id, scopes, issued_at, expires_at, authorization_code_hash, sid) \
             VALUES ('code-sessionless', 'app', '[]', '{EARLIER}', '{FUTURE}', 'hash-1', NULL), \
                    ('code-dead', 'app', '[]', '{EARLIER}', '{PAST}', 'hash-2', NULL), \
                    ('code-in-session', 'app', '[]', '{EARLIER}', '{FUTURE}', 'hash-3', 'sid-1'), \
                    ('device', 'device-app', '[]', '{EARLIER}', '{FUTURE}', NULL, NULL); \
             INSERT INTO refresh_tokens (token_hash, family_id, issued_at, consumed_at) \
             VALUES ('spent', 'code-sessionless', '{EARLIER}', '{EARLIER}'), \
                    ('live', 'code-sessionless', '{EARLIER}', NULL), \
                    ('dead', 'code-dead', '{EARLIER}', NULL), \
                    ('in-session', 'code-in-session', '{EARLIER}', NULL), \
                    ('device', 'device', '{EARLIER}', NULL); \
             INSERT INTO authorization_codes \
             (code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, \
              issued_at, expires_at, sid) \
             VALUES ('sessionless', 'sessionless', 'app', 'https://example/', 'challenge', \
                     '[]', '{EARLIER}', '{FUTURE}', NULL), \
                    ('in-session', 'in-session', 'app', 'https://example/', 'challenge', \
                     '[]', '{EARLIER}', '{FUTURE}', 'sid-1'); \
             INSERT INTO authorization_requests \
             (id, grant_type, client_id, requested_scopes, requested_at, expires_at, status, sid) \
             VALUES ('sessionless', 'authorization_code', 'app', '[]', '{EARLIER}', '{FUTURE}', \
                     'pending', NULL), \
                    ('in-session', 'authorization_code', 'app', '[]', '{EARLIER}', '{FUTURE}', \
                     'pending', 'sid-1'), \
                    ('device', 'device_code', 'device-app', '[]', '{EARLIER}', '{FUTURE}', \
                     'pending', NULL)"
        ))
        .expect("families, tokens, codes and requests at 0041");
        let read = |conn: &mut SqliteConnection, query: &str| {
            diesel::sql_query(query)
                .load::<OptionalName>(conn)
                .expect("read")
                .into_iter()
                .map(|row| row.name)
                .collect::<Vec<_>>()
        };
        let family_expiry = |conn: &mut SqliteConnection, family_id: &str| {
            read(
                conn,
                &format!(
                    "SELECT expires_at AS name FROM refresh_token_families \
                     WHERE family_id = '{family_id}'"
                ),
            )
            .remove(0)
            .expect("an expiry")
        };
        let consumed_at = |conn: &mut SqliteConnection, token_hash: &str| {
            read(
                conn,
                &format!(
                    "SELECT consumed_at AS name FROM refresh_tokens \
                     WHERE token_hash = '{token_hash}'"
                ),
            )
            .remove(0)
        };

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0042"),
        )
        .expect("upgrade through 0042");

        let ended_at = family_expiry(&mut conn, "code-sessionless");
        let ended_at_time = chrono::DateTime::parse_from_str(&ended_at, "%F %T%.f%:z")
            .unwrap_or_else(|_| panic!("{ended_at} is in the diesel chrono text encoding"));
        assert!(ended_at_time <= chrono::Utc::now(), "the family ended");
        assert_eq!(consumed_at(&mut conn, "live"), Some(ended_at));
        assert_eq!(consumed_at(&mut conn, "spent").as_deref(), Some(EARLIER));
        assert_eq!(family_expiry(&mut conn, "code-dead"), PAST);
        assert_eq!(consumed_at(&mut conn, "dead"), None);
        for (family_id, token_hash) in [("code-in-session", "in-session"), ("device", "device")] {
            assert_eq!(family_expiry(&mut conn, family_id), FUTURE, "{family_id}");
            assert_eq!(consumed_at(&mut conn, token_hash), None, "{token_hash}");
        }
        assert_eq!(
            read(&mut conn, "SELECT code AS name FROM authorization_codes"),
            [Some("in-session".to_owned())]
        );
        assert_eq!(
            read(
                &mut conn,
                "SELECT id || ':' || status AS name FROM authorization_requests ORDER BY id"
            ),
            [
                Some("device:pending".to_owned()),
                Some("in-session:pending".to_owned()),
                Some("sessionless:expired".to_owned()),
            ]
        );
        let insert_sessionless_code = |conn: &mut SqliteConnection| {
            conn.batch_execute(&format!(
                "INSERT INTO authorization_codes \
                 (code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, \
                  issued_at, expires_at, sid) \
                 VALUES ('another', 'another', 'app', 'https://example/', 'challenge', '[]', \
                         '{EARLIER}', '{FUTURE}', NULL)"
            ))
        };
        assert!(
            insert_sessionless_code(&mut conn).is_err(),
            "a code names its session"
        );

        let migration_0042 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0042"))
            .expect("0042 is embedded");
        migration_0042.revert(&mut conn).expect("revert 0042");
        insert_sessionless_code(&mut conn).expect("a code's sid is nullable again");
        assert_eq!(
            read(
                &mut conn,
                "SELECT code AS name FROM authorization_codes ORDER BY code"
            ),
            [Some("another".to_owned()), Some("in-session".to_owned())]
        );
    }

    /// An install already at `0042` gains
    /// `authorization_requests.session_shortfall_acknowledged` when `0043`
    /// runs: every existing request, of either flow, reads as acknowledged,
    /// so none is hidden from the Owner. Reverting `0043` drops the column and
    /// `session_shortfall_acknowledgements`.
    #[test]
    fn an_install_already_at_0042_acknowledges_every_existing_request() {
        use diesel::connection::SimpleConnection as _;
        const AT: &str = "2026-10-18 00:00:00+00:00";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0042"),
        )
        .expect("migrate to 0042");
        conn.batch_execute(&format!(
            "INSERT INTO authorization_requests \
             (id, grant_type, client_id, requested_scopes, requested_at, expires_at, status, sid) \
             VALUES ('code', 'authorization_code', 'app', '[]', '{AT}', '{AT}', 'pending', \
                     'sid-1'), \
                    ('device', 'device_code', 'device-app', '[]', '{AT}', '{AT}', 'pending', \
                     NULL)"
        ))
        .expect("two requests at 0042");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0043"),
        )
        .expect("upgrade through 0043");
        let acknowledged = diesel::sql_query(
            "SELECT CAST(session_shortfall_acknowledged AS TEXT) AS name \
             FROM authorization_requests ORDER BY id",
        )
        .load::<OptionalName>(&mut conn)
        .expect("read the column")
        .into_iter()
        .map(|row| row.name)
        .collect::<Vec<_>>();
        assert_eq!(acknowledged, [Some("1".to_owned()), Some("1".to_owned())]);

        let migration_0043 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0043"))
            .expect("0043 is embedded");
        migration_0043.revert(&mut conn).expect("revert 0043");
        assert!(
            diesel::sql_query("SELECT session_shortfall_acknowledged FROM authorization_requests")
                .execute(&mut conn)
                .is_err(),
            "the column is gone"
        );
        assert!(
            diesel::sql_query("SELECT sid FROM session_shortfall_acknowledgements")
                .execute(&mut conn)
                .is_err(),
            "the table is gone"
        );
    }

    /// An install already at `0043` loses its stored `expired` status when
    /// `0044` runs: an approved request a poll redeemed (it carries its
    /// `granted_scopes`) becomes `claimed`, and any other `expired` row (a
    /// request `0042` ended) is deleted, as is a code request from before the
    /// browser-session flow (no `sid`). The `code_challenge_method` column,
    /// always `S256`, goes. Reverting `0044` brings the column back as `S256`
    /// on every code row and stores a claim as `expired` again.
    #[test]
    fn an_install_already_at_0043_claims_redeemed_requests_and_drops_the_rest() {
        use diesel::connection::SimpleConnection as _;
        const AT: &str = "2026-10-18 00:00:00+00:00";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0043"),
        )
        .expect("migrate to 0043");
        conn.batch_execute(&format!(
            "INSERT INTO authorization_requests \
             (id, grant_type, client_id, requested_scopes, requested_at, expires_at, status, \
              granted_scopes, user_code, code_challenge, code_challenge_method, sid, \
              redirect_uri, client_state) \
             VALUES ('redeemed', 'device_code', 'device-app', '[]', '{AT}', '{AT}', 'expired', \
                     '[\"openid\"]', 'UC-1', NULL, NULL, NULL, NULL, NULL), \
                    ('ended', 'authorization_code', 'app', '[]', '{AT}', '{AT}', 'expired', \
                     NULL, NULL, 'challenge', 'S256', NULL, 'https://app.example/cb', 's'), \
                    ('pre-session', 'authorization_code', 'app', '[]', '{AT}', '{AT}', \
                     'approved', '[\"openid\"]', NULL, 'challenge', 'S256', NULL, \
                     'https://app.example/cb', 's'), \
                    ('pending', 'authorization_code', 'app', '[]', '{AT}', '{AT}', 'pending', \
                     NULL, NULL, 'challenge', 'S256', 'sid-1', 'https://app.example/cb', 's')"
        ))
        .expect("requests at 0043");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0044"),
        )
        .expect("upgrade through 0044");
        let statuses = |conn: &mut SqliteConnection| {
            diesel::sql_query(
                "SELECT id || ':' || status AS name FROM authorization_requests ORDER BY id",
            )
            .load::<Name>(conn)
            .expect("read")
            .into_iter()
            .map(|row| row.name)
            .collect::<Vec<_>>()
        };
        assert_eq!(statuses(&mut conn), ["pending:pending", "redeemed:claimed"]);
        assert!(
            diesel::sql_query("SELECT code_challenge_method FROM authorization_requests")
                .execute(&mut conn)
                .is_err(),
            "the method column is gone"
        );

        let migration_0044 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0044"))
            .expect("0044 is embedded");
        migration_0044.revert(&mut conn).expect("revert 0044");
        assert_eq!(statuses(&mut conn), ["pending:pending", "redeemed:expired"]);
        let methods = diesel::sql_query(
            "SELECT code_challenge_method AS name FROM authorization_requests ORDER BY id",
        )
        .load::<OptionalName>(&mut conn)
        .expect("read the method column")
        .into_iter()
        .map(|row| row.name)
        .collect::<Vec<_>>();
        assert_eq!(methods, [Some("S256".to_owned()), None]);
    }

    /// An install already at `0044` gains `clients.registration_source` when
    /// `0045` runs, every existing row trusted on first use; seeding's upsert
    /// then marks the rows it owns server-defined on the next boot. Reverting
    /// `0045` drops the column.
    #[test]
    fn an_install_already_at_0044_starts_every_client_trusted_on_first_use() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0044"),
        )
        .expect("migrate to 0044");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0045"),
        )
        .expect("upgrade through 0045");
        let sources = diesel::sql_query("SELECT DISTINCT registration_source AS name FROM clients")
            .load::<Name>(&mut conn)
            .expect("read the column")
            .into_iter()
            .map(|row| row.name)
            .collect::<Vec<_>>();
        assert_eq!(sources, ["trusted_on_first_use"]);

        let migration_0045 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0045"))
            .expect("0045 is embedded");
        migration_0045.revert(&mut conn).expect("revert 0045");
        assert!(
            diesel::sql_query("SELECT registration_source FROM clients")
                .execute(&mut conn)
                .is_err(),
            "the column is gone"
        );
    }

    /// An install already at `0045` renames each browser session's `kind`
    /// when `0046` runs: `owner` becomes `same_device` and `approved` becomes
    /// `paired`, and the rest of each row is kept, `revoked_at` included. The
    /// rebuilt table takes only the new kinds. Reverting `0046` maps them
    /// back.
    #[test]
    fn an_install_already_at_0045_renames_the_browser_session_kinds() {
        use diesel::connection::SimpleConnection as _;
        const CREATED_AT: &str = "2026-10-16 00:00:00+00:00";
        const LAST_SEEN_AT: &str = "2026-10-16 02:00:00+00:00";
        const REVOKED_AT: &str = "2026-10-16 03:00:00+00:00";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0045"),
        )
        .expect("migrate to 0045");
        conn.batch_execute(&format!(
            "INSERT INTO browser_sessions \
             (sid, kind, name, scopes, created_at, expires_at, revoked_at, last_seen_at) \
             VALUES ('same-device', 'owner', NULL, '[\"system/*.cruds\"]', '{CREATED_AT}', \
                     '2026-10-16 08:00:00+00:00', NULL, '{LAST_SEEN_AT}'), \
                    ('paired', 'approved', 'A tablet', '[\"wildflower/launch\"]', \
                     '{CREATED_AT}', '2026-10-17 00:00:00+00:00', NULL, '{LAST_SEEN_AT}'), \
                    ('revoked', 'approved', 'A phone', '[]', '{CREATED_AT}', \
                     '2026-10-17 00:00:00+00:00', '{REVOKED_AT}', '{CREATED_AT}')"
        ))
        .expect("three sessions at 0045");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0046"),
        )
        .expect("upgrade through 0046");

        let column_of = |conn: &mut SqliteConnection, column: &str, sid: &str| {
            diesel::sql_query(format!(
                "SELECT {column} AS name FROM browser_sessions WHERE sid = ?"
            ))
            .bind::<diesel::sql_types::Text, _>(sid)
            .load::<OptionalName>(conn)
            .expect("read the session")
            .remove(0)
            .name
        };
        assert_eq!(
            column_of(&mut conn, "kind", "same-device").as_deref(),
            Some("same_device")
        );
        assert_eq!(
            column_of(&mut conn, "kind", "paired").as_deref(),
            Some("paired")
        );
        assert_eq!(
            column_of(&mut conn, "kind", "revoked").as_deref(),
            Some("paired")
        );
        assert_eq!(column_of(&mut conn, "name", "same-device"), None);
        assert_eq!(
            column_of(&mut conn, "scopes", "same-device").as_deref(),
            Some("[\"system/*.cruds\"]")
        );
        assert_eq!(
            column_of(&mut conn, "name", "paired").as_deref(),
            Some("A tablet")
        );
        assert_eq!(
            column_of(&mut conn, "expires_at", "paired").as_deref(),
            Some("2026-10-17 00:00:00+00:00")
        );
        assert_eq!(
            column_of(&mut conn, "last_seen_at", "paired").as_deref(),
            Some(LAST_SEEN_AT)
        );
        assert_eq!(column_of(&mut conn, "revoked_at", "paired"), None);
        assert_eq!(
            column_of(&mut conn, "revoked_at", "revoked").as_deref(),
            Some(REVOKED_AT)
        );
        assert_eq!(
            column_of(&mut conn, "created_at", "revoked").as_deref(),
            Some(CREATED_AT)
        );
        assert!(
            conn.batch_execute(&format!(
                "INSERT INTO browser_sessions \
                 (sid, kind, name, scopes, created_at, expires_at, last_seen_at) \
                 VALUES ('old', 'owner', NULL, '[]', '{CREATED_AT}', '{CREATED_AT}', \
                         '{CREATED_AT}')"
            ))
            .is_err(),
            "the rebuilt CHECK refuses the old kinds"
        );
        assert!(
            conn.batch_execute(&format!(
                "INSERT INTO browser_sessions \
                 (sid, kind, name, scopes, created_at, expires_at, last_seen_at) \
                 VALUES ('same-device', 'same_device', NULL, '[]', '{CREATED_AT}', \
                         '{CREATED_AT}', '{CREATED_AT}')"
            ))
            .is_err(),
            "sid stays the primary key"
        );

        let migration_0046 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0046"))
            .expect("0046 is embedded");
        migration_0046.revert(&mut conn).expect("revert 0046");
        assert_eq!(
            column_of(&mut conn, "kind", "same-device").as_deref(),
            Some("owner")
        );
        assert_eq!(
            column_of(&mut conn, "kind", "paired").as_deref(),
            Some("approved")
        );
        assert_eq!(
            column_of(&mut conn, "revoked_at", "revoked").as_deref(),
            Some(REVOKED_AT)
        );
    }

    /// An install already at `0046` gives a code request waiting on its
    /// browser's limited page (`pending`, unacknowledged) its own status when
    /// `0047` runs, `awaiting_limited_page`, and drops
    /// `session_shortfall_acknowledged`. Every other in-flight row keeps its
    /// status and columns: an acknowledged pending code request, an approved
    /// one, a pending device request, an approved one its poll hasn't claimed
    /// yet (its approval, name and last poll), a claimed pairing, and a denied
    /// device request sharing its `user_code` with a pending one. The partial
    /// unique index on a pending `user_code` still holds. Reverting `0047`
    /// brings the column back and the waiting request to `pending`, unset.
    #[test]
    fn an_install_already_at_0046_gives_the_limited_page_its_own_status() {
        use diesel::connection::SimpleConnection as _;
        const AT: &str = "2026-10-20 00:00:00+00:00";
        const UNTIL: &str = "2026-10-20 00:05:00+00:00";
        const POLLED_AT: &str = "2026-10-20 00:01:00+00:00";

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0046"),
        )
        .expect("migrate to 0046");
        conn.batch_execute(&format!(
            "INSERT INTO authorization_requests \
             (id, grant_type, client_id, requested_scopes, code_challenge, redirect_uri, \
              client_state, user_code, requested_at, expires_at, last_polled_at, status, \
              granted_scopes, patient, device_name, sid, session_shortfall_acknowledged) \
             VALUES \
             ('code-waiting', 'authorization_code', 'app', '[\"read\"]', 'challenge', \
              'https://app.example/cb', 's', NULL, '{AT}', '{UNTIL}', NULL, 'pending', \
              NULL, NULL, NULL, 'sid-1', 0), \
             ('code-pending', 'authorization_code', 'app', '[\"read\"]', 'challenge', \
              'https://app.example/cb', 's', NULL, '{AT}', '{UNTIL}', NULL, 'pending', \
              NULL, NULL, NULL, 'sid-1', 1), \
             ('code-approved', 'authorization_code', 'app', '[\"read\"]', 'challenge', \
              'https://app.example/cb', 's', NULL, '{AT}', '{UNTIL}', NULL, 'approved', \
              '[\"read\"]', 'Patient/1', NULL, 'sid-1', 1), \
             ('device-pending', 'device_code', 'device-app', '[\"openid\"]', NULL, NULL, \
              NULL, 'SAME-CODE', '{AT}', '{UNTIL}', '{POLLED_AT}', 'pending', NULL, NULL, \
              NULL, NULL, 1), \
             ('device-approved', 'device_code', 'device-app', '[\"openid\"]', NULL, NULL, \
              NULL, 'APPR-OVED', '{AT}', '{UNTIL}', '{POLLED_AT}', 'approved', \
              '[\"openid\"]', 'Patient/2', 'Kitchen iPad', NULL, 1), \
             ('pairing-claimed', 'browser_pairing', 'browser-session', '[]', NULL, NULL, \
              NULL, 'PAIR-CODE', '{AT}', '{UNTIL}', NULL, 'claimed', \
              '[\"wildflower/launch\"]', NULL, 'Firefox on Linux', NULL, 1), \
             ('device-denied', 'device_code', 'device-app', '[\"openid\"]', NULL, NULL, \
              NULL, 'SAME-CODE', '{AT}', '{UNTIL}', NULL, 'denied', NULL, NULL, NULL, \
              NULL, 1)"
        ))
        .expect("in-flight requests at 0046");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0047"),
        )
        .expect("upgrade through 0047");
        let rows = |conn: &mut SqliteConnection, columns: &str| {
            diesel::sql_query(format!(
                "SELECT id || ':' || {columns} AS name FROM authorization_requests ORDER BY id"
            ))
            .load::<Name>(conn)
            .expect("read the requests")
            .into_iter()
            .map(|row| row.name)
            .collect::<Vec<_>>()
        };
        assert_eq!(
            rows(&mut conn, "status"),
            [
                "code-approved:approved",
                "code-pending:pending",
                "code-waiting:awaiting_limited_page",
                "device-approved:approved",
                "device-denied:denied",
                "device-pending:pending",
                "pairing-claimed:claimed",
            ]
        );
        assert_eq!(
            rows(
                &mut conn,
                "COALESCE(granted_scopes, '-') || ':' || COALESCE(patient, '-') || ':' || \
                 COALESCE(device_name, '-') || ':' || COALESCE(last_polled_at, '-') || ':' || \
                 COALESCE(user_code, '-')"
            ),
            [
                "code-approved:[\"read\"]:Patient/1:-:-:-",
                "code-pending:-:-:-:-:-",
                "code-waiting:-:-:-:-:-",
                format!(
                    "device-approved:[\"openid\"]:Patient/2:Kitchen iPad:{POLLED_AT}:APPR-OVED"
                )
                .as_str(),
                "device-denied:-:-:-:-:SAME-CODE",
                format!("device-pending:-:-:-:{POLLED_AT}:SAME-CODE").as_str(),
                "pairing-claimed:[\"wildflower/launch\"]:-:Firefox on Linux:-:PAIR-CODE",
            ]
        );
        assert!(
            diesel::sql_query("SELECT session_shortfall_acknowledged FROM authorization_requests")
                .execute(&mut conn)
                .is_err(),
            "the column is gone"
        );
        let plant_on_same_code = |conn: &mut SqliteConnection, id: &str, status: &str| {
            conn.batch_execute(&format!(
                "INSERT INTO authorization_requests \
                 (id, grant_type, client_id, requested_scopes, user_code, requested_at, \
                  expires_at, status) \
                 VALUES ('{id}', 'device_code', 'device-app', '[]', 'SAME-CODE', '{AT}', \
                         '{UNTIL}', '{status}')"
            ))
        };
        assert!(
            plant_on_same_code(&mut conn, "another-pending", "pending").is_err(),
            "a second pending request on a code collides"
        );
        plant_on_same_code(&mut conn, "another-denied", "denied")
            .expect("a decided request shares a code");

        let migration_0047 = MIGRATIONS
            .migrations()
            .expect("embedded migrations")
            .into_iter()
            .find(|migration| migration.name().version() == MigrationVersion::from("0047"))
            .expect("0047 is embedded");
        migration_0047.revert(&mut conn).expect("revert 0047");
        let reverted = rows(
            &mut conn,
            "status || ':' || CAST(session_shortfall_acknowledged AS TEXT)",
        );
        assert!(reverted.contains(&"code-waiting:pending:0".to_owned()));
        assert!(reverted.contains(&"code-pending:pending:1".to_owned()));
        assert!(reverted.contains(&"device-pending:pending:1".to_owned()));
    }

    /// Running the migrations twice is a no-op the second time (the namespaced
    /// runner skips already-applied versions) and every expected table — plus
    /// the `grants` view — exists afterwards, so opening an existing database
    /// never re-drops or errors.
    #[test]
    fn migrations_are_idempotent_and_create_the_schema() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("first run");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("second run");
        let names: Vec<String> = diesel::sql_query(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
        )
        .load::<Name>(&mut conn)
        .expect("list tables")
        .into_iter()
        .map(|n| n.name)
        .collect();
        for expected in [
            "authorization_code_grants",
            "authorization_codes",
            "authorization_requests",
            "clients",
            "device_grants",
            "grants",
            "browser_sessions",
            "launch_contexts",
            "refresh_token_families",
            "refresh_tokens",
            "session_shortfall_acknowledgements",
            "signing_keys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    /// Migration `0001` is a destructive rebaseline: applied over a database
    /// carrying the retired rusqlite-migrated tables (simulated here by
    /// pre-creating an old-shape `grants` parent + child with a row in it),
    /// it drops them and recreates the final shape — no copy, no error.
    #[test]
    fn migration_rebaselines_over_the_old_rusqlite_tables() {
        use diesel::connection::SimpleConnection;

        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        conn.batch_execute(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE grants (
                 id TEXT PRIMARY KEY NOT NULL,
                 client_id TEXT NOT NULL,
                 scopes TEXT NOT NULL,
                 granted_at TEXT NOT NULL,
                 last_used_at TEXT,
                 patient TEXT,
                 grant_type TEXT NOT NULL
             );
             CREATE TABLE authorization_code_grants (
                 id TEXT PRIMARY KEY NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
                 client_id TEXT NOT NULL,
                 redirect_uri TEXT NOT NULL
             );
             INSERT INTO grants VALUES
                 ('g1', 'c1', '[]', '2024-01-01 00:00:00+00:00', NULL, NULL,
                  'authorization_code');
             INSERT INTO authorization_code_grants VALUES
                 ('g1', 'c1', 'https://example.com/cb');",
        )
        .expect("simulate the old schema");

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MIGRATIONS,
        )
        .expect("rebaseline");

        // The old parent's row is gone (destructive) and `grants` is now the
        // UNION ALL view over the two rebuilt concrete tables.
        let grants: Vec<Name> = diesel::sql_query("SELECT id AS name FROM grants")
            .load(&mut conn)
            .expect("grants view is queryable");
        assert!(grants.is_empty(), "the rebaseline copies no data");
        let kind: Vec<Name> =
            diesel::sql_query("SELECT type AS name FROM sqlite_master WHERE name = 'grants'")
                .load(&mut conn)
                .expect("sqlite_master");
        assert_eq!(kind.len(), 1);
        assert_eq!(kind[0].name, "view");
    }

    /// The in-memory constructor produces an independent, migrated store per
    /// call — the isolation every store test relies on.
    #[test]
    fn open_in_memory_stores_are_independent() {
        let a = SqliteGrantStore::open_in_memory().expect("store a");
        let b = SqliteGrantStore::open_in_memory().expect("store b");
        let key = crate::domain::signing_key::SigningKey::generate().expect("generate key");
        a.write(|tx| tx.insert_signing_key(&key))
            .expect("insert into a");
        assert_eq!(a.read(|tx| tx.all_signing_keys()).expect("read a").len(), 1);
        assert_eq!(
            b.read(|tx| tx.all_signing_keys()).expect("read b").len(),
            0,
            "store b must not see store a's key",
        );
    }

    /// An install already at `0026` loses both Web Trace clients when it
    /// upgrades, with every grant and refresh token they hold, under the
    /// foreign key `refresh_tokens` keeps on its family.
    #[test]
    fn an_install_already_at_0026_loses_the_web_trace_clients() {
        let mut conn = SqliteConnection::establish(":memory:").expect("open in-memory");
        diesel::sql_query("PRAGMA foreign_keys = ON")
            .execute(&mut conn)
            .expect("enforce foreign keys, as the pool does");
        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0026"),
        )
        .expect("migrate to 0026");
        for statement in [
            "INSERT INTO clients \
             (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
              secret_hash, registered_at, disabled_at) \
             VALUES ('web-trace-app-dev', 'Web Trace (Dev)', 'public', \
                     '[\"http://localhost:5191/\"]', '[\"launch\"]', \
                     '[\"authorization_code\"]', NULL, '2024-01-01 00:00:00+00:00', NULL)",
            "INSERT INTO refresh_token_families \
             (family_id, client_id, scopes, issued_at, expires_at) \
             VALUES ('web-trace-family', 'web-trace-app', '[]', '2024-01-01', '2099-01-01')",
            "INSERT INTO refresh_token_families \
             (family_id, client_id, scopes, issued_at, expires_at) \
             VALUES ('importer-family', 'importer-app', '[]', '2024-01-01', '2099-01-01')",
            "INSERT INTO refresh_tokens (token_hash, family_id, issued_at) \
             VALUES ('web-trace-token', 'web-trace-family', '2024-01-01')",
            "INSERT INTO refresh_tokens (token_hash, family_id, issued_at) \
             VALUES ('importer-token', 'importer-family', '2024-01-01')",
        ] {
            diesel::sql_query(statement)
                .execute(&mut conn)
                .expect("plant a 0026 row");
        }

        wildflowerhealthio_persistence::run_diesel_migrations(
            &mut conn,
            MIGRATION_NAMESPACE,
            MigrationsThrough("0027"),
        )
        .expect("upgrade through 0027");

        for client_id in ["web-trace-app", "web-trace-app-dev"] {
            assert!(column_for_client(&mut conn, "client_id", client_id).is_empty());
        }
        assert_eq!(
            column_for_client(&mut conn, "client_id", "importer-app").len(),
            1
        );
        let token_hashes: Vec<Name> =
            diesel::sql_query("SELECT token_hash AS name FROM refresh_tokens ORDER BY token_hash")
                .load(&mut conn)
                .expect("query refresh_tokens");
        let token_hashes: Vec<&str> = token_hashes.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(
            token_hashes,
            ["importer-token"],
            "another client's tokens stay"
        );
    }
}

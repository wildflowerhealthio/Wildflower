//! The `SqliteAppsStore` adapter — the `SQLite` implementation of the
//! [`AppsStore`](crate::domain::AppsStore) port over the one `app_registrations`
//! table. Holds the app-wide r2d2 pool of Diesel `SqliteConnection`s
//! (`persistence_rust::DieselPool`) onto the shared database file, applies the
//! embedded apps migrations once on construction, and implements the port's
//! queries: the catalogue read, the by-id read, the insert / content replace /
//! delete mutators, and the atomic homescreen placement rewrite (the single
//! writer of `position` / `on_homescreen`). Mirrors `collector-rust`'s
//! `SqliteRemotesStore`.
//!
//! This file also owns the [`app_registrations`] `table!` definition and the
//! [`AppUrlColumn`] mapping for its `url` column — both referenced by the domain
//! [`AppRegistration`](crate::domain::AppRegistration)'s diesel derive, so they
//! stay `pub`. Insert and replace hand back the stored registration via
//! `RETURNING` on the writing statement — no separate read-back — which also
//! re-decodes the stored `url`, so a value that no longer round-trips surfaces as
//! a typed error.

use std::collections::HashSet;

use anyhow::Context;
use diesel::deserialize::{FromSql, FromSqlRow};
use diesel::expression::AsExpression;
use diesel::prelude::*;
use diesel::serialize::{IsNull, Output, ToSql};
use diesel::sql_types::Text;
use diesel::sqlite::{Sqlite, SqliteValue};
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::{DieselPool, PooledDieselConnection};

use crate::domain::{is_exact_registry_permutation, AppRegistration, AppUrl, AppsError, AppsStore};

diesel::table! {
    app_registrations (id) {
        id -> Text,
        position -> BigInt,
        on_homescreen -> Bool,
        name -> Text,
        subtitle -> Nullable<Text>,
        url -> Text,
        client_id -> Nullable<Text>,
        requires_tunnel -> Bool,
    }
}

/// An [`AppUrl`] bound to / read from the `url` TEXT column as its string. A
/// stored value that no longer parses surfaces as a diesel deserialization error,
/// never a panic or an unsafe redirect target. A row struct plugs it in on its
/// plain `AppUrl` field with `#[diesel(serialize_as = …, deserialize_as = …)]`.
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Text)]
pub struct AppUrlColumn(AppUrl);

impl From<AppUrl> for AppUrlColumn {
    fn from(url: AppUrl) -> Self {
        Self(url)
    }
}

impl From<AppUrlColumn> for AppUrl {
    fn from(column: AppUrlColumn) -> Self {
        column.0
    }
}

impl FromSql<Text, Sqlite> for AppUrlColumn {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> diesel::deserialize::Result<Self> {
        let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
        Ok(Self(text.parse()?))
    }
}

impl ToSql<Text, Sqlite> for AppUrlColumn {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> diesel::serialize::Result {
        out.set_value(self.0.to_string());
        Ok(IsNull::No)
    }
}

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
/// of the pool (via [`connection`](SqliteAppsStore::connection)) and runs its
/// query on it. Every method returns the port's PRIMITIVE shape — absence as
/// `None`, a delete outcome as `bool` — leaving the semantic verdicts to the
/// [`capabilities`](crate::domain::capabilities).
impl AppsStore for SqliteAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        list_registrations_on(&mut *self.connection()?)
    }

    fn find_app(&self, id: &str) -> Result<Option<AppRegistration>, AppsError> {
        app_registrations::table
            .find(id)
            .select(AppRegistration::as_select())
            .first(&mut *self.connection()?)
            .optional()
            .map_err(|e| AppsError::infrastructure("find app failed", e))
    }

    fn insert_app(&self, registration: &AppRegistration) -> Result<AppRegistration, AppsError> {
        // IMMEDIATE so the `next_position` read + insert can't race a concurrent create —
        // see the transaction-discipline section of `docs/Apps/Store Explanation.md`.
        self.connection()?.immediate_transaction(|conn| {
            // The store owns `position` (tail append); everything else is the caller's.
            diesel::insert_into(app_registrations::table)
                .values(AppRegistration {
                    position: next_position(conn)?,
                    ..registration.clone()
                })
                .returning(AppRegistration::as_returning())
                .get_result(conn)
                .map_err(|e| {
                    tracing::error!(id = %registration.id, "app insert failed: {e}");
                    AppsError::infrastructure(
                        "app insert failed",
                        format!("id={}: {e}", registration.id),
                    )
                })
        })
    }

    fn replace_app(
        &self,
        registration: &AppRegistration,
    ) -> Result<Option<AppRegistration>, AppsError> {
        diesel::update(app_registrations::table.find(&registration.id))
            .set((
                app_registrations::name.eq(&registration.name),
                app_registrations::subtitle.eq(&registration.subtitle),
                app_registrations::url.eq(AppUrlColumn::from(registration.url.clone())),
                app_registrations::requires_tunnel.eq(registration.requires_tunnel),
            ))
            .returning(AppRegistration::as_returning())
            .get_result(&mut *self.connection()?)
            .optional()
            .map_err(|e| AppsError::infrastructure("app update failed", e))
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
        let removed = diesel::delete(app_registrations::table.find(id))
            .execute(&mut *self.connection()?)
            .map_err(|e| AppsError::infrastructure("delete app failed", e))?;
        Ok(removed == 1)
    }

    fn replace_placements(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppsError> {
        // IMMEDIATE so the permutation read and the renumber can't be split by a concurrent
        // add/remove — see the transaction-discipline section of
        // `docs/Apps/Store Explanation.md`.
        self.connection()?.immediate_transaction(|conn| {
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
            diesel::sql_query("UPDATE app_registrations SET position = -1 - position")
                .execute(conn)
                .map_err(|e| AppsError::infrastructure("placement renumber staging failed", e))?;
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
                    .execute(conn)
                    .map_err(|e| AppsError::infrastructure("placement renumber failed", e))?;
            }

            // Read the new registry inside the transaction so the response can't
            // reflect a write that landed after the renumber.
            let updated = list_registrations_on(conn)?;
            Ok(Some(updated))
        })
    }
}

/// The catalogue read against an arbitrary connection — shared by
/// [`list_registrations`](AppsStore::list_registrations) and the placement
/// transaction (which calls it on its open transaction so the post-renumber read
/// stays in the same transaction).
fn list_registrations_on(conn: &mut SqliteConnection) -> Result<Vec<AppRegistration>, AppsError> {
    app_registrations::table
        .order(app_registrations::position)
        .select(AppRegistration::as_select())
        .load(conn)
        .map_err(|e| AppsError::infrastructure("list registrations failed", e))
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry).
/// [`insert_app`](AppsStore::insert_app) appends at the tail with it.
fn next_position(conn: &mut SqliteConnection) -> Result<i64, AppsError> {
    let max: Option<i64> = app_registrations::table
        .select(diesel::dsl::max(app_registrations::position))
        .first(conn)
        .map_err(|e| AppsError::infrastructure("next-position read failed", e))?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Every registration id (the global app-id space) as a set — the home-screen
/// permutation check's live-registry input, read inside the placement transaction.
fn all_registration_ids(conn: &mut SqliteConnection) -> Result<HashSet<String>, AppsError> {
    Ok(app_registrations::table
        .select(app_registrations::id)
        .load::<String>(conn)
        .map_err(|e| AppsError::infrastructure("registration-ids read failed", e))?
        .into_iter()
        .collect())
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::db::test_support::{error_text, SEEDED_IDS};
    use crate::domain::test_fake::registration;

    fn launch_url(raw: &str) -> AppUrl {
        raw.parse().expect("a valid test launch url")
    }

    /// `list_registrations` reports `is_smart`, `requires_tunnel`, and the launch
    /// template per row.
    #[test]
    fn list_registrations_reports_the_facts_per_row() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        for id in ["growth-chart", "medication-viewer", "precise-hbr"] {
            let reg = registrations
                .iter()
                .find(|r| r.id == id)
                .expect("seeded row");
            assert!(reg.is_smart(), "{id} must be smart");
            assert!(reg.requires_tunnel, "{id} requires the tunnel");
            assert!(
                reg.url.to_string().contains("{launch}"),
                "{id} carries its launch template",
            );
        }
    }

    /// `find_app` reads the whole app; an unknown id is `None`.
    #[test]
    fn find_app_reads_the_whole_app() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registration = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(registration.name, "Growth Chart");
        assert!(registration.is_smart());
        assert!(registration.requires_tunnel);
        assert!(registration.url.to_string().contains("growth-chart-app"));
        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    /// A stored `url` that no longer parses surfaces as a typed read error (the
    /// `AppUrlColumn` deserialize), not a silent unsafe value. A `javascript:`
    /// scheme is one such rejected shape (an XSS redirect target).
    #[test]
    fn find_app_rejects_an_unparseable_stored_url() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        diesel::sql_query(
            "UPDATE app_registrations SET url = 'javascript:alert(1)' WHERE id = 'growth-chart'",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        let error = store
            .find_app("growth-chart")
            .expect_err("an unparseable url must fail the read");
        assert!(
            error_text(&error).contains("find app failed"),
            "error should name the read: {error:?}",
        );
    }

    #[test]
    fn insert_app_returns_the_stored_registration_and_round_trips() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let inserted = store.insert_app(&registration("app-x")).expect("inserted");
        assert_eq!(store.find_app("app-x").unwrap(), Some(inserted.clone()));
        assert_eq!(inserted.position, 10, "the store assigns the tail position");
        assert!(inserted.on_homescreen);
        assert!(!inserted.is_smart(), "inserted app has no client_id");
        assert_eq!(inserted.url, launch_url("https://example.com/launch"));
        assert!(!inserted.requires_tunnel);
    }

    /// A taken id fails the insert as an infrastructure error naming the id —
    /// the primary key rejects it, so nothing is written and the existing row is
    /// untouched.
    #[test]
    fn insert_app_rejects_a_taken_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let app = registration("app-x");
        store.insert_app(&app).expect("inserted");
        let error = store
            .insert_app(&AppRegistration {
                name: "Second".to_owned(),
                ..app
            })
            .expect_err("a second insert with the same id must fail");
        assert!(
            error_text(&error).contains("id=app-x"),
            "error should name the id: {error:?}",
        );
        let stored = store.find_app("app-x").unwrap().unwrap();
        assert_eq!(stored.name, "app-x", "the existing row is untouched");
        assert_eq!(stored.position, 10);
    }

    #[test]
    fn replace_app_writes_the_editable_fields() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store.insert_app(&registration("app-x")).expect("inserted");

        let mut edited = AppRegistration {
            url: launch_url("https://example.com/edited"),
            ..registration("app-x")
        };
        edited.name = "Renamed".to_owned();
        edited.subtitle = Some("the new subtitle".to_owned());
        edited.requires_tunnel = true;
        let replaced = store.replace_app(&edited).unwrap().expect("replaced");
        assert_eq!(replaced.name, "Renamed");
        assert_eq!(replaced.subtitle.as_deref(), Some("the new subtitle"));
        assert!(replaced.requires_tunnel);
        assert_eq!(replaced.url, launch_url("https://example.com/edited"));
        assert_eq!(store.find_app("app-x").unwrap(), Some(replaced));
    }

    /// A content replace must not touch `on_homescreen` — `PUT /home-screen` is that
    /// flag's single writer — even though the caller-built registration carries the
    /// `on_homescreen = true` default.
    #[test]
    fn replace_app_leaves_on_homescreen_alone() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store.insert_app(&registration("app-x")).expect("inserted");

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
        assert!(!store.find_app("app-x").unwrap().unwrap().on_homescreen);

        let mut edited = registration("app-x");
        edited.name = "Renamed".to_owned();
        let replaced = store.replace_app(&edited).unwrap().expect("replaced");
        assert!(
            !replaced.on_homescreen,
            "a content replace must not re-show a hidden app",
        );
    }

    #[test]
    fn replace_app_returns_none_for_unknown_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        assert!(store.replace_app(&registration("ghost")).unwrap().is_none());
    }

    /// Delete removes the row, for a user-created and a seeded app alike.
    #[test]
    fn delete_app_removes_the_registration() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store.insert_app(&registration("my-app")).expect("inserted");
        assert!(store.delete_app("my-app").unwrap());
        assert!(store.find_app("my-app").unwrap().is_none());
        assert!(
            !store.delete_app("my-app").unwrap(),
            "a second delete of the same id removes nothing",
        );

        assert!(store.delete_app("growth-chart").unwrap());
        assert!(store.find_app("growth-chart").unwrap().is_none());
        assert!(!store.delete_app("no-such-id").unwrap());
    }

    /// `replace_placements` renumbers every row to its array index and applies
    /// each `on_homescreen` flag, in one shot — leaving a dense `0..n` permutation
    /// (no ties).
    #[test]
    fn replace_placements_renumbers_and_sets_on_homescreen() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let entries: Vec<(String, bool)> = SEEDED_IDS
            .iter()
            .rev()
            .map(|id| ((*id).to_owned(), *id != "precise-hbr"))
            .collect();
        let updated = store
            .replace_placements(&entries)
            .unwrap()
            .expect("an exact permutation renumbers and returns the registry");

        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|r| r.id.clone()).collect();
        assert_eq!(returned_ids, expected);

        for (position, (id, _)) in entries.iter().enumerate() {
            let registration = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                registration.position,
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        assert!(
            !store
                .find_app("precise-hbr")
                .unwrap()
                .unwrap()
                .on_homescreen
        );
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

        let subset = vec![
            ("growth-chart".to_owned(), true),
            ("precise-hbr".to_owned(), true),
        ];
        assert!(store.replace_placements(&subset).unwrap().is_none());

        let dup = vec![
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("precise-hbr".to_owned(), true),
            ("growth-chart".to_owned(), true),
        ];
        assert!(store.replace_placements(&dup).unwrap().is_none());

        assert_eq!(
            before,
            ids_now(&store),
            "a rejected body must not reorder anything"
        );
    }
}

#[cfg(test)]
mod migration_tests {
    use diesel::migration::{Migration, MigrationSource, MigrationVersion};
    use diesel::prelude::*;
    use diesel::sql_types::{BigInt, Integer, Text};
    use diesel::sqlite::{Sqlite, SqliteConnection};
    use diesel::{sql_query, QueryableByName};
    use persistence_rust::DieselPool;

    use super::*;
    use crate::db::test_support::SEEDED_IDS;

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
        assert_eq!(row_count, 10, "exactly the ten seeded default apps");
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

    /// [`SEEDED_IDS`] as an install migrated before `0015` holds them, in display
    /// order: every seeded app but the Health Viewer, which `0015` appends after
    /// any app the user created before upgrading.
    fn seeded_before_0015() -> Vec<&'static str> {
        SEEDED_IDS
            .into_iter()
            .filter(|id| *id != "health-viewer-app")
            .collect()
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
    /// ids `0005` gave them, launching at the app root (`0016`).
    #[test]
    fn first_party_apps_launch_from_the_published_site() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        for (id, url) in [
            (
                "medications-app",
                "https://wildflowerhealth.io/medications-app/?launch={launch}&iss={origin}/fhir-r4",
            ),
            (
                "web-trace-app",
                "https://wildflowerhealth.io/web-trace-app/?launch={launch}&iss={origin}/fhir-r4",
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
                 target must resolve to the server's public origin",
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
             server's public HTTPS origin",
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
    /// at its published Pages copy's root (`0016`) — a SMART EHR launch, unlike
    /// the server-docs console's `?server=` target.
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
             server's public HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/importer-app/?launch={launch}&iss={origin}/fhir-r4",
        );
    }

    /// The OHIF imaging viewer ships as a first-party app (apps migration `0007`),
    /// launched from its published Pages copy. Its launch URL is a route, not the
    /// app root: OHIF reads the SMART parameters off whichever route it is
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
             server's public HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer",
        );
    }

    /// Lifting ships as a first-party app (apps migration `0010`), launched at
    /// its published Pages copy's root (`0016`) — a SMART EHR launch.
    #[test]
    fn lifting_app_launches_at_its_root() {
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
             server's public HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/lifting-app/?launch={launch}&iss={origin}/fhir-r4",
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

    /// The Synthesized Health Viewer is seeded as a SMART app (`client_id ==
    /// id`) launching at its published Pages copy's root (`0016`) — a SMART EHR
    /// launch.
    #[test]
    fn health_viewer_app_launches_at_its_root() {
        let store = SqliteAppsStore::open_in_memory().unwrap();

        let registration = store
            .find_app("health-viewer-app")
            .unwrap()
            .expect("health-viewer-app must exist");
        assert_eq!(registration.client_id.as_deref(), Some("health-viewer-app"));
        assert_eq!(registration.name, "Synthesized Health Viewer");
        assert_eq!(
            registration.subtitle.as_deref(),
            Some("Plot labs, vitals and doses on one chart"),
        );
        assert!(registration.on_homescreen);
        assert!(
            registration.requires_tunnel,
            "the published page's `iss={{origin}}` fetch must resolve through the \
             server's public HTTPS origin",
        );
        assert_eq!(
            registration.url.to_string(),
            "https://wildflowerhealth.io/health-viewer-app/?launch={launch}&iss={origin}/fhir-r4",
        );
    }

    /// An install already at `0014` gains the Health Viewer when it upgrades —
    /// at the tail, after an app the user created before upgrading, since
    /// `position` is UNIQUE and `0015` appends rather than naming a literal slot.
    #[test]
    fn an_install_already_at_0014_gains_the_health_viewer_at_the_tail() {
        let pool = pool_migrated_through("0014");
        sql_query(
            "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, url, requires_tunnel) \
             VALUES ('my-app', (SELECT MAX(position) + 1 FROM app_registrations), 1, 'My App', \
                     'https://example.com/launch', 0)",
        )
        .execute(&mut pool.get().unwrap())
        .expect("a 0014 registration insert must succeed");

        let store = SqliteAppsStore::new(pool).expect("0015 must apply over the user's app");
        let user_app = store
            .find_app("my-app")
            .unwrap()
            .expect("the user's app survives");
        let health_viewer = store
            .find_app("health-viewer-app")
            .unwrap()
            .expect("0015 must seed health-viewer-app on an upgraded install");
        assert_eq!(
            health_viewer.position,
            user_app.position + 1,
            "the Health Viewer takes the tail, after the user's app",
        );
    }

    /// Reverting `0015` removes the Health Viewer and leaves every other app.
    #[test]
    fn reverting_0015_removes_the_health_viewer() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        embedded_migration("0015")
            .revert(&mut store.pool().get().unwrap())
            .expect("revert 0015");

        assert!(store.find_app("health-viewer-app").unwrap().is_none());
        assert_eq!(
            store.list_registrations().unwrap().len(),
            SEEDED_IDS.len() - 1,
            "every other app stays",
        );
    }

    /// An install already at `0015` moves its first-party launches from
    /// `launch.html` to the app root when it upgrades, and a debug build's dev
    /// rows with them, while a launch URL the user edited, production or dev,
    /// is left as it is.
    #[test]
    fn an_install_already_at_0015_launches_first_party_apps_at_their_roots() {
        let pool = pool_migrated_through("0015");
        let mut conn = pool.get().unwrap();
        let edited = "https://lifting.example/launch.html?launch={launch}&iss={origin}/fhir-r4";
        sql_query("UPDATE app_registrations SET url = ? WHERE id = 'lifting-app'")
            .bind::<Text, _>(edited)
            .execute(&mut conn)
            .expect("the user edits Lifting's launch URL");
        sql_query(
            "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, url, client_id, requires_tunnel) \
             VALUES ('medications-app-dev', (SELECT MAX(position) + 1 FROM app_registrations), \
                     1, 'Medications (Dev)', \
                     'http://localhost:5191/launch.html?launch={launch}&iss={origin}/fhir-r4', \
                     'medications-app-dev', 0)",
        )
        .execute(&mut conn)
        .expect("a dev row seeded before 0016");
        let edited_dev =
            "http://localhost:5192/launch.html?launch={launch}&iss=https://ehr.example/fhir";
        sql_query(
            "INSERT INTO app_registrations \
             (id, position, on_homescreen, name, url, client_id, requires_tunnel) \
             VALUES ('web-trace-app-dev', (SELECT MAX(position) + 1 FROM app_registrations), \
                     1, 'Web Trace (Dev)', ?, 'web-trace-app-dev', 0)",
        )
        .bind::<Text, _>(edited_dev)
        .execute(&mut conn)
        .expect("a dev row the user pointed elsewhere");
        drop(conn);

        let store = SqliteAppsStore::new(pool).expect("0016 must apply");
        for id in [
            "medications-app",
            "web-trace-app",
            "importer-app",
            "health-viewer-app",
        ] {
            assert_eq!(
                stored_url(&store, id),
                format!(
                    "https://wildflowerhealth.io/{id}/?launch={{launch}}&iss={{origin}}/fhir-r4"
                ),
            );
        }
        assert_eq!(
            stored_url(&store, "lifting-app"),
            edited,
            "the user's edit stays"
        );
        assert_eq!(
            stored_url(&store, "medications-app-dev"),
            "http://localhost:5191/?launch={launch}&iss={origin}/fhir-r4",
        );
        assert_eq!(
            stored_url(&store, "web-trace-app-dev"),
            edited_dev,
            "a dev row off the old seed's shape stays"
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
        let mut expected = seeded_before_0015();
        expected.extend(["my-cloud-app", "health-viewer-app"]);
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
        let mut expected = seeded_before_0015();
        expected.extend(["kept-https", "kept-http", "health-viewer-app"]);
        assert_eq!(
            ids, expected,
            "the origin-relative apps are gone and the rest keep their order"
        );
        let positions: Vec<i64> = registrations.iter().map(|r| r.position).collect();
        let dense: Vec<i64> = (0..).take(positions.len()).collect();
        assert_eq!(positions, dense, "positions are renumbered to a dense 0..n");
    }
}

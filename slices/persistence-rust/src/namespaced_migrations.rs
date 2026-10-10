//! A **namespaced** diesel migration runner, so several diesel-backed slices can
//! embed their own `migrations/` trees and apply them against one shared
//! database without their versions colliding.
//!
//! # Why this exists
//!
//! Diesel's stock [`MigrationHarness::run_pending_migrations`] records applied
//! versions in a single, un-namespaced `__diesel_schema_migrations` table keyed
//! by the migration *version* (the directory-name prefix before the first `_`).
//! That is fine for one crate owning one database, but every slice here starts
//! its history at `0001_initial_schema`, so the moment a *second* diesel slice
//! runs its migrations against the shared file, diesel sees version `0001`
//! already applied and **silently skips the second slice's migration** — the
//! table it should create is never created.
//!
//! This is the diesel counterpart of [`crate::run_migrations`] (the rusqlite
//! runner), which has always kept slices apart with a per-`namespace`
//! `schema_migrations` table. This runner restores that invariant for diesel:
//! applied versions are tracked per `(namespace, version)` in
//! [`TRACKING_TABLE`], so slice `A`'s `0001` and slice `B`'s `0001` are distinct
//! rows and both run.
//!
//! Each pending migration is applied inside its own transaction (mirroring
//! diesel's own per-migration transaction and the rusqlite runner), so a
//! migration and the row that records it land atomically.
//!
//! [`MigrationHarness::run_pending_migrations`]: diesel_migrations::MigrationHarness::run_pending_migrations

use std::collections::HashSet;

use anyhow::Context;
use diesel::connection::Connection;
use diesel::migration::{Migration, MigrationSource};
use diesel::sqlite::{Sqlite, SqliteConnection};
use diesel::{sql_query, sql_types::Text, QueryableByName, RunQueryDsl};

/// The per-slice migration bookkeeping table: one row per applied
/// `(namespace, version)`. Disjoint from the rusqlite runner's
/// `schema_migrations`, so both can coexist in one shared database.
const TRACKING_TABLE: &str = "CREATE TABLE IF NOT EXISTS diesel_slice_migrations (\
    namespace TEXT NOT NULL, \
    version   TEXT NOT NULL, \
    PRIMARY KEY (namespace, version)\
) STRICT;";

/// A `version` column read from the tracking table.
#[derive(QueryableByName)]
struct VersionRow {
    #[diesel(sql_type = Text)]
    version: String,
}

/// Apply `source`'s pending migrations for `namespace` against `conn`, tracking
/// applied versions per `(namespace, version)` in [`TRACKING_TABLE`] so slices
/// sharing one database never collide on a version number.
///
/// `migrations` is append-only (never reorder or rewrite a shipped entry). Each
/// pending migration runs in its own transaction together with the row that
/// records it, so a migration and its bookkeeping land atomically.
///
/// # Errors
///
/// Returns an error if the tracking table can't be created, the applied-version
/// set can't be read, the embedded migrations can't be loaded, or a migration
/// (or its bookkeeping insert) fails.
pub fn run_diesel_migrations<S: MigrationSource<Sqlite>>(
    conn: &mut SqliteConnection,
    namespace: &str,
    source: S,
) -> anyhow::Result<()> {
    sql_query(TRACKING_TABLE)
        .execute(conn)
        .context("create diesel_slice_migrations tracking table")?;

    let applied: HashSet<String> =
        sql_query("SELECT version FROM diesel_slice_migrations WHERE namespace = ?")
            .bind::<Text, _>(namespace)
            .load::<VersionRow>(conn)
            .context("read applied migration versions")?
            .into_iter()
            .map(|row| row.version)
            .collect();

    let mut migrations = source
        .migrations()
        .map_err(|e| anyhow::anyhow!("load embedded migrations: {e}"))?;
    // Apply oldest-first. diesel already returns them sorted, but sort
    // explicitly so the runner never depends on that.
    migrations.sort_by(|a, b| a.name().version().cmp(&b.name().version()));

    for migration in migrations {
        let version = migration.name().version().to_string();
        if applied.contains(&version) {
            continue;
        }
        conn.transaction::<(), anyhow::Error, _>(|conn| {
            migration
                .run(conn)
                .map_err(|e| anyhow::anyhow!("run migration {version}: {e}"))?;
            sql_query(
                "INSERT OR IGNORE INTO diesel_slice_migrations (namespace, version) \
                 VALUES (?, ?)",
            )
            .bind::<Text, _>(namespace)
            .bind::<Text, _>(&version)
            .execute(conn)?;
            Ok(())
        })
        .with_context(|| format!("applying migration {version} for namespace {namespace}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use diesel_migrations::{embed_migrations, EmbeddedMigrations};

    use super::*;

    // Two independent migration trees whose *only* migration is `0001_initial_schema`
    // in each — the exact version-number clash that broke diesel's stock harness.
    const MIG_A: EmbeddedMigrations = embed_migrations!("tests/fixtures/mig_a");
    const MIG_B: EmbeddedMigrations = embed_migrations!("tests/fixtures/mig_b");

    /// A `COUNT(*)` scalar.
    #[derive(QueryableByName)]
    struct CountRow {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        count: i64,
    }

    fn conn() -> SqliteConnection {
        SqliteConnection::establish(":memory:").expect("open in-memory sqlite")
    }

    fn table_exists(conn: &mut SqliteConnection, name: &str) -> bool {
        sql_query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name = ?")
            .bind::<Text, _>(name)
            .get_result::<CountRow>(conn)
            .unwrap()
            .count
            > 0
    }

    fn applied_versions(conn: &mut SqliteConnection, namespace: &str) -> Vec<String> {
        sql_query(
            "SELECT version FROM diesel_slice_migrations WHERE namespace = ? ORDER BY version",
        )
        .bind::<Text, _>(namespace)
        .load::<VersionRow>(conn)
        .unwrap()
        .into_iter()
        .map(|r| r.version)
        .collect()
    }

    /// The regression for the shipped bug: two slices whose first migration is
    /// both `0001_initial_schema` apply against ONE database — diesel's stock
    /// harness would skip the second because version `0001` was already recorded
    /// in the shared `__diesel_schema_migrations`.
    #[test]
    fn same_version_in_different_namespaces_both_apply() {
        let mut conn = conn();
        run_diesel_migrations(&mut conn, "alpha", MIG_A).unwrap();
        run_diesel_migrations(&mut conn, "beta", MIG_B).unwrap();

        assert!(table_exists(&mut conn, "alpha"), "alpha's 0001 ran");
        assert!(table_exists(&mut conn, "beta"), "beta's 0001 ran");
        assert_eq!(applied_versions(&mut conn, "alpha"), vec!["0001"]);
        assert_eq!(applied_versions(&mut conn, "beta"), vec!["0001"]);
    }

    /// Re-running a namespace's migrations is a no-op the second time — the
    /// version is already recorded, so the (non-idempotent) `CREATE TABLE` never
    /// re-runs.
    #[test]
    fn re_running_is_idempotent() {
        let mut conn = conn();
        run_diesel_migrations(&mut conn, "alpha", MIG_A).unwrap();
        run_diesel_migrations(&mut conn, "alpha", MIG_A).unwrap();
        assert_eq!(applied_versions(&mut conn, "alpha"), vec!["0001"]);
    }
}

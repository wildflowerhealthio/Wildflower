//! The `AppsStore` handle — wraps the shared SQLite connection, applies the
//! per-namespace migrations onto it, and exposes the parent-registry (`apps`
//! table) reads + reorder/enable writes. The kind-specific child operations
//! live in sibling modules (`cloud_apps`, `self_hosted_apps`) as further
//! `impl AppsStore` blocks — split out only because each `sql_row!`-generated
//! `ALL_COLS` is module-scoped and would otherwise collide.
//!
//! This module also owns the rusqlite `ToSql`/`FromSql` glue for the two column
//! newtypes the registry stores: [`Provenance`] (the kebab discriminant) and
//! [`AppUrl`] (the cloud launch template — used by the `cloud_apps` mapping).

use anyhow::Context;
use persistence_rust::{sql_row, Connection, DbResult};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::{params, OptionalExtension, ToSql};

use crate::domain::{App, AppListEntry, AppUrl, Provenance};

#[derive(Clone)]
pub struct AppsStore {
    conn: Connection,
}

impl AppsStore {
    /// Wrap the shared `conn` and apply pending apps migrations onto it.
    /// The connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the apps migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply apps migrations")?;
        }
        Ok(Self { conn })
    }

    /// Open a private in-memory shared connection and wrap it — for tests.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(Connection::open_in_memory().context("failed to open in-memory sqlite")?)
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// The `GET /apps` catalogue: every parent row projected to its wire
    /// [`AppListEntry`], ordered by `position`. `requires_tunnel` comes from the
    /// optional `cloud_apps` child (`0` for system / self-hosted); `smart` is
    /// derived from `client_id IS NOT NULL`.
    ///
    /// Hand-written (not `sql_row!`) because of the JOIN, the computed `smart`
    /// column, and the `requires_tunnel` alias.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_app_entries(&self) -> DbResult<Vec<AppListEntry>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT a.id, a.enabled, a.name, a.subtitle, a.provenance, a.local_only, \
             (a.client_id IS NOT NULL) AS smart, \
             COALESCE(c.requires_tunnel, 0) AS requires_tunnel \
             FROM apps a \
             LEFT JOIN cloud_apps c ON c.id = a.id \
             ORDER BY a.position",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AppListEntry {
                id: row.get("id")?,
                enabled: row.get("enabled")?,
                name: row.get("name")?,
                subtitle: row.get("subtitle")?,
                provenance: row.get("provenance")?,
                local_only: row.get("local_only")?,
                smart: row.get("smart")?,
                requires_tunnel: row.get("requires_tunnel")?,
            })
        })?;
        rows.collect()
    }

    /// A single parent registry row by id, `None` when absent. Backs the launch
    /// dispatch (provenance lookup) and the cloud-admin existence/editability
    /// checks.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_app(&self, id: &str) -> DbResult<Option<App>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM apps WHERE id = ?1"),
                params![id],
                |row| App::try_from(row),
            )
            .optional()
    }

    /// Set a parent row's `enabled` flag. Returns `true` when a row matched.
    /// Allowed for every provenance (the homescreen toggle works on any app).
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> DbResult<bool> {
        let affected = self.conn().lock().execute(
            "UPDATE apps SET enabled = ?2 WHERE id = ?1",
            params![id, enabled],
        )?;
        Ok(affected == 1)
    }

    /// Set a parent row's display `position`. Returns `true` when a row matched.
    /// Allowed for every provenance (drag-to-reorder works on any app).
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update.
    pub fn set_position(&self, id: &str, position: i64) -> DbResult<bool> {
        let affected = self.conn().lock().execute(
            "UPDATE apps SET position = ?2 WHERE id = ?1",
            params![id, position],
        )?;
        Ok(affected == 1)
    }

    /// The next free display position — `MAX(position) + 1`, or `0` for an empty
    /// table. Used by the cloud-app create flow to append the new row.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn next_position(&self) -> DbResult<i64> {
        self.conn().lock().query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM apps",
            [],
            |row| row.get(0),
        )
    }
}

impl ToSql for Provenance {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        // The kebab discriminant the `CHECK (provenance IN (...))` constraint
        // matches; the one `str::parse` round-trips.
        Ok(ToSqlOutput::Owned(Value::Text(self.as_str().to_owned())))
    }
}

impl FromSql for Provenance {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        // An unknown discriminant (a tampered row) surfaces as a typed read
        // error rather than a panic.
        s.parse::<Provenance>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for AppUrl {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        // The canonical string (see `AppUrl`'s `Display`) — the only form the
        // `url` column ever holds, and the one `str::parse` round-trips.
        Ok(ToSqlOutput::Owned(Value::Text(self.to_string())))
    }
}

impl FromSql for AppUrl {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        // A stored URL that no longer parses (e.g. an externally tampered row)
        // surfaces as a typed read error rather than a silent unsafe redirect.
        s.parse::<AppUrl>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

// `App`'s field names match the parent `apps` table column names, so the macro
// derives `TryFrom<&Row>`, `make_named_sql_params`, and `ALL_COLS` off the
// single field list.
sql_row!(App {
    id,
    name,
    subtitle,
    enabled,
    position,
    provenance,
    local_only,
    client_id,
});

/// Migration namespace for the apps tables in the shared database.
const NAMESPACE: &str = "apps";

/// Apply pending apps migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `apps` namespace, so
/// they coexist with other slices in one shared database.
fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. The 4th entry (`004_apps_registry.sql`) replaces the
/// two flat tables with the parent registry + per-kind child tables and seeds
/// the full default set. Because each migration runs only once per database, a
/// user-deleted seeded row stays deleted across upgrades — only fresh installs
/// see the full default set.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_internal_apps_table.sql"),
    include_str!("../migrations/003_seed_precise_hbr.sql"),
    include_str!("../migrations/004_apps_registry.sql"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::system_app::SYSTEM_APPS;

    #[test]
    fn migrate_is_idempotent_and_creates_the_registry_tables() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        for table in ["apps", "cloud_apps", "self_hosted_apps"] {
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            assert!(exists, "{table} table must exist after migrate");
        }
    }

    /// Migration 004 seeds the full default set: 6 parent rows in display order
    /// with the right provenance, plus the matching child rows.
    #[test]
    fn migration_seeds_the_default_registry() {
        let store = AppsStore::open_in_memory().unwrap();
        let entries = store.list_app_entries().unwrap();
        let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
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

    /// `list_app_entries` reports `smart` only for the cloud (SMART-client) rows
    /// and `local_only` for the loopback ones, ordered by position.
    #[test]
    fn list_app_entries_reports_smart_and_local_only_per_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let entries = store.list_app_entries().unwrap();
        let by_id = |id: &str| entries.iter().find(|e| e.id == id).expect("seeded row");

        // The 3 cloud apps carry a gatekeeper client_id → smart.
        for cloud in ["growth-chart", "medication-viewer", "precise-hbr"] {
            assert!(by_id(cloud).smart, "{cloud} must be smart");
            assert_eq!(by_id(cloud).provenance, Provenance::Cloud);
            assert!(by_id(cloud).requires_tunnel, "{cloud} requires the tunnel");
        }
        // The loopback apps are local-only and not smart.
        for local in ["patient-browser", "api-view", "api-docs"] {
            assert!(by_id(local).local_only, "{local} must be local-only");
            assert!(!by_id(local).smart, "{local} must not be smart");
            assert!(
                !by_id(local).requires_tunnel,
                "{local} must not require the tunnel",
            );
        }
        assert_eq!(by_id("patient-browser").provenance, Provenance::SelfHosted);
        assert_eq!(by_id("api-view").provenance, Provenance::System);
        assert_eq!(by_id("api-docs").provenance, Provenance::System);
    }

    /// The parent primary key gives global id uniqueness across kinds — a second
    /// parent row with a seeded id is rejected by the PK.
    #[test]
    fn parent_id_is_globally_unique() {
        let store = AppsStore::open_in_memory().unwrap();
        let dup = store.conn().lock().execute(
            "INSERT INTO apps (id, name, enabled, position, provenance, local_only) \
             VALUES ('api-docs', 'dup', 1, 99, 'cloud', 0)",
            [],
        );
        assert!(dup.is_err(), "duplicate parent id must violate the PK");
    }

    #[test]
    fn find_app_reads_the_parent_row() {
        let store = AppsStore::open_in_memory().unwrap();
        let app = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(app.name, "Growth Chart");
        assert_eq!(app.provenance, Provenance::Cloud);
        assert_eq!(app.client_id.as_deref(), Some("growth_chart"));
        assert!(app.smart());
        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    #[test]
    fn set_enabled_and_set_position_touch_any_provenance() {
        let store = AppsStore::open_in_memory().unwrap();
        // A system app (api-docs) — enable/position writes are not provenance-gated.
        assert!(store.set_enabled("api-docs", false).unwrap());
        assert!(!store.find_app("api-docs").unwrap().unwrap().enabled);
        assert!(store.set_position("api-docs", 42).unwrap());
        assert_eq!(store.find_app("api-docs").unwrap().unwrap().position, 42);
        // Unknown id → false, not an error.
        assert!(!store.set_enabled("ghost", true).unwrap());
        assert!(!store.set_position("ghost", 1).unwrap());
    }

    #[test]
    fn next_position_returns_max_plus_one() {
        let store = AppsStore::open_in_memory().unwrap();
        // Six seeded rows at positions 0..=5.
        assert_eq!(store.next_position().unwrap(), 6);
    }

    /// The compiled-in [`SYSTEM_APPS`] source list must agree with the seeded
    /// `provenance = 'system'` parent rows on id / name / subtitle / local_only.
    #[test]
    fn system_app_source_matches_seeded_system_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        let entries = store.list_app_entries().unwrap();
        let system_rows: Vec<&AppListEntry> = entries
            .iter()
            .filter(|e| e.provenance == Provenance::System)
            .collect();
        assert_eq!(
            system_rows.len(),
            SYSTEM_APPS.len(),
            "seeded system rows and the SYSTEM_APPS source must be 1:1",
        );
        for source in SYSTEM_APPS {
            let row = system_rows
                .iter()
                .find(|e| e.id == source.id)
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
}

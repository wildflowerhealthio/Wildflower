//! The `AppsStore` handle — wraps the shared SQLite connection, applies the
//! per-namespace migrations onto it, and exposes the parent-registry (`apps`
//! table) reads + reorder/enable writes. The kind-specific child operations live
//! in sibling modules (`cloud_apps`, `self_hosted_apps`); see [`crate::db`] for
//! why they're split.
//!
//! This module also owns the rusqlite `ToSql`/`FromSql` glue for the two column
//! newtypes the registry stores: [`Provenance`] (the kebab discriminant) and
//! [`AppUrl`] (the cloud launch template — used by the `cloud_apps` mapping).

use std::collections::HashSet;

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
    /// [`AppListEntry`] variant (keyed on `provenance`), ordered by `position`.
    /// The cloud variant's `url` / `requires_tunnel` come from the `cloud_apps`
    /// child and the self-hosted variant's `launch_path` from `self_hosted_apps`;
    /// `smart` / `removable` are computed. See [`app_entry_from_row`].
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_app_entries(&self) -> DbResult<Vec<AppListEntry>> {
        let conn = self.conn().lock();
        list_app_entries_on(&conn)
    }

    /// The single-row counterpart to [`Self::list_app_entries`]: the wire
    /// [`AppListEntry`] for `id`, or `None` if absent. The create / replace
    /// handlers read it after a write so their response is the *exact* `GET /apps`
    /// projection (correct `smart` / `removable` / variant), never a hand-built
    /// one that could drift.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_app_entry(&self, id: &str) -> DbResult<Option<AppListEntry>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {APP_ENTRY_COLUMNS} WHERE a.id = ?1"),
                params![id],
                app_entry_from_row,
            )
            .optional()
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

    /// Atomically validate **and** rewrite the whole homescreen — the ordering
    /// **and** the `enabled` flags — in one transaction. The body must list every
    /// registry app exactly once; each `(id, enabled)` at index `i` sets that
    /// row's `position = i` and `enabled`. Returns the resulting catalogue in its
    /// new order (read inside the same transaction), or `Ok(None)` when `entries`
    /// isn't an exact permutation of the live registry — the caller maps that to
    /// `400 InvalidHomeScreen`.
    ///
    /// Validating against the live ids **inside** the transaction (rather than a
    /// separate read the handler did before) closes the window where a concurrent
    /// create/delete could land between the check and the renumber. Because every
    /// row is renumbered to its array index under one transaction, positions stay
    /// a dense `0..n` permutation (no duplicate or gapped positions) and a reorder
    /// can't be observed half-applied. This is the single writer of
    /// `position`/`enabled` across every provenance; `PUT /home-screen` is its
    /// sole caller.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn replace_home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> DbResult<Option<Vec<AppListEntry>>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;

        // Validate against the live registry under the same lock/transaction as
        // the renumber: the body must be an exact permutation of the current ids.
        let current_ids: HashSet<String> = {
            let mut stmt = tx.prepare("SELECT id FROM apps")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<HashSet<String>>>()?
        };
        let body_ids: HashSet<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        let id_set_changed = entries.len() != current_ids.len()
            || body_ids.len() != entries.len()
            || body_ids
                .iter()
                .any(|body_id| !current_ids.contains(*body_id));
        if id_set_changed {
            // Drop the transaction without committing (rolls back); nothing was
            // written. The handler turns `None` into `400 InvalidHomeScreen`.
            return Ok(None);
        }

        {
            // Move every row to a disjoint negative range first so the per-row
            // renumber below never transiently collides with `UNIQUE(position)`
            // (SQLite's UNIQUE is immediate, not deferrable): originals are `>= 0`
            // and `-1 - position` is `<= -1`, so the two ranges never overlap.
            tx.execute("UPDATE apps SET position = -1 - position", [])?;
            // Prepared once and reused across rows — `tx.execute` would re-parse
            // and re-plan the UPDATE on every iteration. The block scopes the
            // statements so they drop before `commit()` consumes the transaction.
            let mut update_app_statement =
                tx.prepare("UPDATE apps SET position = ?2, enabled = ?3 WHERE id = ?1")?;
            for (position, (id, enabled)) in entries.iter().enumerate() {
                let position = i64::try_from(position).expect("home-screen length fits i64");
                update_app_statement.execute(params![id, position, enabled])?;
            }
        }

        // Read the new catalogue inside the transaction so the response can't
        // reflect a write that landed after the renumber.
        let updated_entry_list = list_app_entries_on(&tx)?;
        tx.commit()?;
        Ok(Some(updated_entry_list))
    }
}

/// The columns every app-entry projection selects, in one place so the list and
/// single-row reads can't drift. The two child JOINs supply `url` /
/// `requires_tunnel` (cloud) and `launch_path` (self-hosted); `smart` /
/// `removable` are computed; the row is mapped per provenance by
/// [`app_entry_from_row`].
const APP_ENTRY_COLUMNS: &str = "a.id, a.enabled, a.name, a.subtitle, a.provenance, a.local_only, \
     (a.client_id IS NOT NULL) AS smart, \
     c.url AS url, \
     COALESCE(c.requires_tunnel, 0) AS requires_tunnel, \
     (a.provenance = 'cloud' \
      OR (a.provenance = 'self-hosted' AND COALESCE(s.seeded, 1) = 0)) AS removable, \
     s.launch_path AS launch_path \
     FROM apps a \
     LEFT JOIN cloud_apps c ON c.id = a.id \
     LEFT JOIN self_hosted_apps s ON s.id = a.id";

/// Map an `apps` + child JOIN row (see [`APP_ENTRY_COLUMNS`]) into the
/// `provenance`-discriminated [`AppListEntry`]: shared parent fields for every
/// variant, plus the typed-child fields for cloud (`url` / `requires_tunnel`) and
/// self-hosted (`launch_path`). Hand-written (not `sql_row!`) because of the two
/// JOINs, the computed columns, and the per-provenance shape.
fn app_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppListEntry> {
    let id: String = row.get("id")?;
    let enabled: bool = row.get("enabled")?;
    let name: String = row.get("name")?;
    let subtitle: Option<String> = row.get("subtitle")?;
    let local_only: bool = row.get("local_only")?;
    let smart: bool = row.get("smart")?;
    let removable: bool = row.get("removable")?;
    Ok(match row.get::<_, Provenance>("provenance")? {
        Provenance::System => AppListEntry::System {
            id,
            enabled,
            name,
            subtitle,
            local_only,
            smart,
            removable,
        },
        Provenance::Cloud => AppListEntry::Cloud {
            id,
            enabled,
            name,
            subtitle,
            local_only,
            smart,
            removable,
            url: row.get("url")?,
            requires_tunnel: row.get("requires_tunnel")?,
        },
        Provenance::SelfHosted => AppListEntry::SelfHosted {
            id,
            enabled,
            name,
            subtitle,
            local_only,
            smart,
            removable,
            launch_path: row.get("launch_path")?,
        },
    })
}

/// The `GET /apps` projection against an arbitrary connection — shared by
/// [`AppsStore::list_app_entries`] (which locks then calls this) and
/// [`AppsStore::replace_home_screen`] (which calls it on its open transaction so
/// the post-renumber read stays inside the same transaction).
fn list_app_entries_on(conn: &rusqlite::Connection) -> DbResult<Vec<AppListEntry>> {
    let mut stmt = conn.prepare(&format!("SELECT {APP_ENTRY_COLUMNS} ORDER BY a.position"))?;
    let rows = stmt.query_map([], app_entry_from_row)?;
    rows.collect()
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
/// the full default set; the 5th (`005_self_hosted_seeded.sql`) adds the
/// `seeded` flag distinguishing migration-seeded self-hosted rows from uploaded
/// ones; the 6th (`006_self_hosted_launch_path.sql`) adds the nullable
/// `launch_path` inferred at install for bundles that ship a `launch.html`.
/// Because each migration runs only once per database, a user-deleted seeded
/// row stays deleted across upgrades — only fresh installs see the full default
/// set.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_internal_apps_table.sql"),
    include_str!("../migrations/003_seed_precise_hbr.sql"),
    include_str!("../migrations/004_apps_registry.sql"),
    include_str!("../migrations/005_self_hosted_seeded.sql"),
    include_str!("../migrations/006_self_hosted_launch_path.sql"),
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
        let ids: Vec<&str> = entries.iter().map(AppListEntry::id).collect();
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
        let by_id = |id: &str| entries.iter().find(|e| e.id() == id).expect("seeded row");

        // The 3 cloud apps carry a gatekeeper client_id → smart.
        for cloud in ["growth-chart", "medication-viewer", "precise-hbr"] {
            assert!(by_id(cloud).smart(), "{cloud} must be smart");
            assert_eq!(by_id(cloud).provenance(), Provenance::Cloud);
            assert!(
                by_id(cloud).requires_tunnel(),
                "{cloud} requires the tunnel"
            );
        }
        // The loopback apps are local-only and not smart.
        for local in ["patient-browser", "api-view", "api-docs"] {
            assert!(by_id(local).local_only(), "{local} must be local-only");
            assert!(!by_id(local).smart(), "{local} must not be smart");
            assert!(
                !by_id(local).requires_tunnel(),
                "{local} must not require the tunnel",
            );
        }
        assert_eq!(
            by_id("patient-browser").provenance(),
            Provenance::SelfHosted
        );
        assert_eq!(by_id("api-view").provenance(), Provenance::System);
        assert_eq!(by_id("api-docs").provenance(), Provenance::System);
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

    /// `replace_home_screen` renumbers every row to its array index and applies
    /// each `enabled` flag, in one shot, for any provenance — and leaves the
    /// positions a dense `0..n` permutation (no ties). Reversing the seed (every
    /// row changes position) also exercises the `UNIQUE(position)` collision-free
    /// renumber.
    #[test]
    fn replace_home_screen_renumbers_and_sets_enabled_for_any_provenance() {
        let store = AppsStore::open_in_memory().unwrap();
        // Reverse the seeded order, disabling a system app (api-docs) along the way.
        let entries: Vec<(String, bool)> = vec![
            ("precise-hbr".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("api-docs".to_owned(), false),
            ("api-view".to_owned(), true),
            ("patient-browser".to_owned(), true),
        ];
        let updated = store
            .replace_home_screen(&entries)
            .unwrap()
            .expect("an exact permutation renumbers and returns the catalogue");

        // The returned catalogue is in the new order.
        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|e| e.id().to_owned()).collect();
        assert_eq!(returned_ids, expected);

        // Positions are exactly the array indices (dense 0..n, no duplicates).
        for (position, (id, _)) in entries.iter().enumerate() {
            let app = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                app.position,
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        // The enabled flag was applied (api-docs is a system app — not gated).
        assert!(!store.find_app("api-docs").unwrap().unwrap().enabled);
        // A follow-up list read agrees with the order returned inside the txn.
        let ids: Vec<String> = store
            .list_app_entries()
            .unwrap()
            .iter()
            .map(|e| e.id().to_owned())
            .collect();
        assert_eq!(ids, expected);
    }

    /// A body that isn't an exact permutation of the live registry returns
    /// `Ok(None)` (→ `400`) and writes nothing — validation happens inside the
    /// same transaction as the renumber.
    #[test]
    fn replace_home_screen_rejects_a_non_permutation_without_writing() {
        let store = AppsStore::open_in_memory().unwrap();
        let before: Vec<String> = store
            .list_app_entries()
            .unwrap()
            .iter()
            .map(|e| e.id().to_owned())
            .collect();

        // A subset (missing rows) — not a permutation.
        let subset = vec![("api-view".to_owned(), true), ("api-docs".to_owned(), true)];
        assert!(store.replace_home_screen(&subset).unwrap().is_none());

        // A full-length body with a duplicated id (and a missing one) — also not
        // a permutation.
        let dup = vec![
            ("patient-browser".to_owned(), true),
            ("api-view".to_owned(), true),
            ("api-docs".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("api-view".to_owned(), true),
        ];
        assert!(store.replace_home_screen(&dup).unwrap().is_none());

        // The registry order is untouched.
        let after: Vec<String> = store
            .list_app_entries()
            .unwrap()
            .iter()
            .map(|e| e.id().to_owned())
            .collect();
        assert_eq!(before, after, "a rejected body must not reorder anything");
    }

    /// The compiled-in [`SYSTEM_APPS`] source list must agree with the seeded
    /// `provenance = 'system'` parent rows on id / name / subtitle / local_only.
    #[test]
    fn system_app_source_matches_seeded_system_rows() {
        let store = AppsStore::open_in_memory().unwrap();
        let entries = store.list_app_entries().unwrap();
        let system_rows: Vec<&AppListEntry> = entries
            .iter()
            .filter(|e| e.provenance() == Provenance::System)
            .collect();
        assert_eq!(
            system_rows.len(),
            SYSTEM_APPS.len(),
            "seeded system rows and the SYSTEM_APPS source must be 1:1",
        );
        for source in SYSTEM_APPS {
            let row = system_rows
                .iter()
                .find(|e| e.id() == source.id)
                .unwrap_or_else(|| panic!("no seeded system row for {}", source.id));
            assert_eq!(row.name(), source.name, "{} name", source.id);
            assert_eq!(row.subtitle(), source.subtitle, "{} subtitle", source.id);
            assert_eq!(
                row.local_only(),
                source.local_only,
                "{} local_only",
                source.id,
            );
        }
    }
}

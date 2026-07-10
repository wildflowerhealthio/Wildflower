//! The `RemotesStore` handle — wraps the shared SQLite connection, applies the
//! collector-namespaced migrations onto it, and exposes the
//! `collector_remotes` CRUD the `/collector/remotes` handlers serve.

use anyhow::Context;
use persistence_rust::{build_insert_sql, sql_row, Connection, DbResult};
use rusqlite::{params, OptionalExtension};

use crate::domain::Remote;

#[derive(Clone)]
pub struct RemotesStore {
    conn: Connection,
}

impl RemotesStore {
    /// Wrap the shared `conn` and apply pending collector migrations onto it.
    /// The connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the collector migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply collector migrations")?;
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

    /// Every remote, oldest first (ties broken by id so the order is total) —
    /// the `GET /collector/remotes` catalogue.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn list_remotes(&self) -> DbResult<Vec<Remote>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ALL_COLS} FROM collector_remotes ORDER BY added_at, id"
        ))?;
        let rows = stmt.query_map([], |row| Remote::try_from(row))?;
        rows.collect()
    }

    /// A single remote by id, `None` when absent.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error other than `QueryReturnedNoRows`.
    pub fn find_remote(&self, id: &str) -> DbResult<Option<Remote>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM collector_remotes WHERE id = ?1"),
                params![id],
                |row| Remote::try_from(row),
            )
            .optional()
    }

    /// Insert a fresh remote. Returns `false` when the id is already taken
    /// (`INSERT … ON CONFLICT(id) DO NOTHING` affects 0 rows) — the create
    /// handler maps that to a conflict rather than silently overwriting.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the insert.
    pub fn insert_remote(&self, remote: &Remote) -> DbResult<bool> {
        let named_params = make_named_sql_params(remote);
        let sql = format!(
            "{} ON CONFLICT(id) DO NOTHING",
            build_insert_sql("collector_remotes", &named_params)
        );
        let affected = self.conn().lock().execute(&sql, &named_params[..])?;
        Ok(affected == 1)
    }

    /// Update an existing remote's `name` / `tag` / `config` (id and
    /// `added_at` are immutable) and return the resulting row, or `None` when
    /// no remote has this id. The post-update read happens inside the same
    /// transaction as the write, so the returned row can't reflect a
    /// concurrent write — and a concurrent delete can't produce the
    /// updated-but-gone race a separate find-then-replace would.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the transaction.
    pub fn update_remote(
        &self,
        id: &str,
        name: &str,
        tag: &str,
        config: &persistence_rust::JsonColumn<serde_json::Value>,
    ) -> DbResult<Option<Remote>> {
        let guard = self.conn().lock();
        let tx = guard.unchecked_transaction()?;
        let affected = tx.execute(
            "UPDATE collector_remotes SET name = ?2, tag = ?3, config = ?4 WHERE id = ?1",
            params![id, name, tag, config],
        )?;
        if affected != 1 {
            // No such id — nothing was written; drop the transaction (rolls
            // back). The handler turns `None` into `404 RemoteNotFound`.
            return Ok(None);
        }
        let updated = tx.query_row(
            &format!("SELECT {ALL_COLS} FROM collector_remotes WHERE id = ?1"),
            params![id],
            |row| Remote::try_from(row),
        )?;
        tx.commit()?;
        Ok(Some(updated))
    }

    /// Remove a remote by id. Returns `true` iff a row was deleted; the
    /// handler maps `false` to `404 RemoteNotFound`.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the delete.
    pub fn delete_remote(&self, id: &str) -> DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM collector_remotes WHERE id = ?1", params![id])?;
        Ok(affected == 1)
    }
}

// `Remote`'s field names match the `collector_remotes` column names, so the
// macro derives `TryFrom<&Row>`, `make_named_sql_params`, and `ALL_COLS` off
// the single field list.
sql_row!(Remote {
    id,
    name,
    tag,
    config,
    added_at,
});

/// Migration namespace for the collector tables in the shared database.
const NAMESPACE: &str = "collector";

/// Apply pending collector migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `collector`
/// namespace, so they coexist with other slices in one shared database.
fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. The 2nd entry seeds the demo FHIR remote the retired
/// api_stubs stub used to hardcode; because each migration runs only once per
/// database, a user-deleted seed stays deleted across upgrades.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_seed_fhir_demo.sql"),
];

#[cfg(test)]
mod tests {
    use persistence_rust::JsonColumn;

    use super::*;

    fn remote(id: &str, added_at: &str) -> Remote {
        Remote {
            id: id.to_owned(),
            name: format!("Remote {id}"),
            tag: "fhir-r4".to_owned(),
            config: JsonColumn(serde_json::json!({ "_tag": "fhir-r4", "rootUrl": "https://x" })),
            added_at: added_at.to_owned(),
        }
    }

    #[test]
    fn migrate_is_idempotent_and_creates_the_remotes_table() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='collector_remotes'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(exists, "collector_remotes must exist after migrate");
    }

    /// Migration 002 seeds the demo remote with the exact row the retired
    /// api_stubs stub served — id, tag, verbatim config JSON, and the pinned
    /// `added_at` — so a fresh install keeps today's demo behavior.
    #[test]
    fn migration_seeds_the_demo_fhir_remote() {
        let store = RemotesStore::open_in_memory().unwrap();
        let seeded = store.find_remote("fhir-demo").unwrap().expect("seeded row");
        assert_eq!(seeded.name, "FHIR Demo");
        assert_eq!(seeded.tag, "fhir-r4");
        assert_eq!(seeded.added_at, "2026-06-17T14:29:22.363Z");
        assert_eq!(
            seeded.config.into_inner(),
            serde_json::json!({
                "_tag": "fhir-r4",
                "rootUrl": "https://r4.smarthealthit.org",
                "patientId": "8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882",
            }),
        );
    }

    /// The config JSON round-trips verbatim through the TEXT column —
    /// including fields Rust has never heard of, since the union is TS-owned
    /// and a new collector's config must survive storage unchanged.
    #[test]
    fn insert_round_trips_an_unmodeled_config_verbatim() {
        let store = RemotesStore::open_in_memory().unwrap();
        let mut fresh = remote("r1", "2026-07-01T00:00:00.000Z");
        fresh.tag = "rexall".to_owned();
        fresh.config = JsonColumn(serde_json::json!({
            "_tag": "rexall",
            "username": "u",
            "password": "p",
            "nested": { "deep": [1, 2, 3] },
        }));
        assert!(store.insert_remote(&fresh).unwrap());
        let read = store.find_remote("r1").unwrap().expect("inserted row");
        assert_eq!(read, fresh);
    }

    #[test]
    fn insert_remote_returns_false_on_duplicate_id_without_overwriting() {
        let store = RemotesStore::open_in_memory().unwrap();
        let first = remote("dup", "2026-07-01T00:00:00.000Z");
        assert!(store.insert_remote(&first).unwrap());
        let second = remote("dup", "2026-07-02T00:00:00.000Z");
        assert!(!store.insert_remote(&second).unwrap());
        // The original row is untouched.
        assert_eq!(store.find_remote("dup").unwrap().unwrap(), first);
    }

    /// Listing returns every row oldest-first, with the id as tiebreaker for
    /// same-instant rows — a total order, so the catalogue is deterministic.
    #[test]
    fn list_remotes_orders_by_added_at_then_id() {
        let store = RemotesStore::open_in_memory().unwrap();
        store
            .insert_remote(&remote("b-newer", "2026-07-02T00:00:00.000Z"))
            .unwrap();
        store
            .insert_remote(&remote("z-old", "2026-07-01T00:00:00.000Z"))
            .unwrap();
        store
            .insert_remote(&remote("a-old", "2026-07-01T00:00:00.000Z"))
            .unwrap();
        let ids: Vec<String> = store
            .list_remotes()
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        // The 2026-06 seed sorts first; same-instant rows sort by id.
        assert_eq!(ids, vec!["fhir-demo", "a-old", "z-old", "b-newer"]);
    }

    /// `update_remote` rewrites name/tag/config, preserves id + `added_at`,
    /// and returns the row as stored.
    #[test]
    fn update_remote_rewrites_mutable_fields_and_keeps_added_at() {
        let store = RemotesStore::open_in_memory().unwrap();
        store
            .insert_remote(&remote("r1", "2026-07-01T00:00:00.000Z"))
            .unwrap();
        let new_config = JsonColumn(serde_json::json!({ "_tag": "rexall", "username": "u" }));
        let updated = store
            .update_remote("r1", "Renamed", "rexall", &new_config)
            .unwrap()
            .expect("existing row updates");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.tag, "rexall");
        assert_eq!(updated.config, new_config);
        assert_eq!(updated.added_at, "2026-07-01T00:00:00.000Z");
        assert_eq!(store.find_remote("r1").unwrap().unwrap(), updated);
    }

    #[test]
    fn update_remote_returns_none_for_an_unknown_id() {
        let store = RemotesStore::open_in_memory().unwrap();
        let config = JsonColumn(serde_json::json!({ "_tag": "fhir-r4" }));
        assert!(store
            .update_remote("no-such-id", "n", "fhir-r4", &config)
            .unwrap()
            .is_none());
    }

    #[test]
    fn delete_remote_removes_the_row_and_reports_absence() {
        let store = RemotesStore::open_in_memory().unwrap();
        store
            .insert_remote(&remote("r1", "2026-07-01T00:00:00.000Z"))
            .unwrap();
        assert!(store.delete_remote("r1").unwrap());
        assert!(store.find_remote("r1").unwrap().is_none());
        assert!(
            !store.delete_remote("r1").unwrap(),
            "second delete is a miss"
        );
    }
}

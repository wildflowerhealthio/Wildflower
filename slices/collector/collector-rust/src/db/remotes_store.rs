//! The `RemotesStore` handle — owns a Diesel `SqliteConnection` onto the shared
//! database file, applies the embedded collector migrations onto it, and
//! exposes the `collector_remotes` CRUD the `/collector/remotes` handlers serve.

use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use parking_lot::Mutex;

use crate::db::schema::collector_remotes;
use crate::domain::Remote;

/// The collector migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`RemotesStore::from_connection`]; diesel
/// records applied versions in its own `__diesel_schema_migrations` table,
/// which is disjoint from persistence-rust's namespaced `schema_migrations`, so
/// the two migration bookkeepers coexist in the shared database with no
/// collision. Migration `0002` seeds the demo FHIR remote the retired
/// api_stubs stub used to hardcode; because each migration runs only once per
/// database, a user-deleted seed stays deleted across upgrades.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// Internal row shape — [`Remote`] with `config` held as JSON TEXT (the column
/// type). The store converts between this and [`Remote`], so the domain type
/// stays a plain `serde_json::Value` while the column stays TEXT.
#[derive(Queryable, Selectable, Insertable)]
#[diesel(table_name = collector_remotes)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct RemoteRow {
    id: String,
    name: String,
    tag: String,
    config: String,
    added_at: String,
}

impl From<&Remote> for RemoteRow {
    fn from(remote: &Remote) -> Self {
        Self {
            id: remote.id.clone(),
            name: remote.name.clone(),
            tag: remote.tag.clone(),
            // `serde_json::Value`'s `Display` is compact canonical JSON — the
            // TEXT stored for the config column.
            config: remote.config.to_string(),
            added_at: remote.added_at.clone(),
        }
    }
}

impl TryFrom<RemoteRow> for Remote {
    type Error = anyhow::Error;

    fn try_from(row: RemoteRow) -> anyhow::Result<Self> {
        // A corrupt config TEXT surfaces as an error, never a panic — the
        // handler maps it to an opaque 500.
        let config = serde_json::from_str(&row.config).with_context(|| {
            format!(
                "collector_remotes.config for id {} is not valid JSON",
                row.id
            )
        })?;
        Ok(Remote {
            id: row.id,
            name: row.name,
            tag: row.tag,
            config,
            added_at: row.added_at,
        })
    }
}

#[derive(Clone)]
pub struct RemotesStore {
    // Diesel's connection API is `&mut`, so the single connection is serialized
    // behind a mutex; the `Arc` makes the store cheap to clone into the axum
    // state. This is a SECOND connection onto the same file the host's rusqlite
    // `persistence-rust::Connection` serves the other slices from — SQLite
    // permits multiple connections per file; the `busy_timeout` pragma below
    // rides out the brief write locks either connection takes.
    conn: Arc<Mutex<SqliteConnection>>,
}

impl RemotesStore {
    /// Open the collector's own connection onto the shared database at
    /// `db_path` and apply pending collector migrations onto it. The host opens
    /// its rusqlite connection onto the same file for the other slices; both
    /// coexist (see the `conn` field).
    ///
    /// # Errors
    ///
    /// Returns an error if the parent directory can't be created, the
    /// connection can't be established or configured, or a migration fails.
    pub fn new(db_path: &Path) -> anyhow::Result<Self> {
        // Be robust if the collector opens the file before the host has: create
        // the parent dir the same way `persistence_rust::Connection::open` does.
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create db dir {}", parent.display()))?;
        }
        let database_url = db_path
            .to_str()
            .with_context(|| format!("db path {} is not valid UTF-8", db_path.display()))?;
        let conn = SqliteConnection::establish(database_url)
            .with_context(|| format!("failed to open sqlite at {}", db_path.display()))?;
        Self::from_connection(conn)
    }

    /// Open a private in-memory database and wrap it — for tests. Each call is
    /// an independent database (the connection is the only handle to it).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn =
            SqliteConnection::establish(":memory:").context("failed to open in-memory sqlite")?;
        Self::from_connection(conn)
    }

    /// Apply the per-connection runtime settings the host's rusqlite opener
    /// also applies (`persistence_rust::Connection::configured`) so the two
    /// connections behave identically, then run pending migrations.
    ///
    /// - `busy_timeout` (5s) so a write rides out brief contention from the
    ///   host's connection on the same file instead of failing instantly with
    ///   `SQLITE_BUSY`.
    /// - `foreign_keys = ON`, which SQLite defaults OFF per connection — set
    ///   outside any transaction (the migrations open their own).
    fn from_connection(mut conn: SqliteConnection) -> anyhow::Result<Self> {
        conn.batch_execute("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
            .context("failed to apply collector connection pragmas")?;
        conn.run_pending_migrations(MIGRATIONS)
            .map_err(|e| anyhow::anyhow!("failed to apply collector migrations: {e}"))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Every remote, oldest first (ties broken by id so the order is total) —
    /// the `GET /collector/remotes` catalogue.
    ///
    /// # Errors
    ///
    /// Returns any error from the read or a corrupt stored config.
    pub fn list_remotes(&self) -> anyhow::Result<Vec<Remote>> {
        let mut guard = self.conn.lock();
        let rows: Vec<RemoteRow> = collector_remotes::table
            .order((collector_remotes::added_at, collector_remotes::id))
            .select(RemoteRow::as_select())
            .load(&mut *guard)?;
        rows.into_iter().map(Remote::try_from).collect()
    }

    /// A single remote by id, `None` when absent.
    ///
    /// # Errors
    ///
    /// Returns any error from the read or a corrupt stored config.
    pub fn find_remote(&self, id: &str) -> anyhow::Result<Option<Remote>> {
        let mut guard = self.conn.lock();
        let row: Option<RemoteRow> = collector_remotes::table
            .filter(collector_remotes::id.eq(id))
            .select(RemoteRow::as_select())
            .first(&mut *guard)
            .optional()?;
        row.map(Remote::try_from).transpose()
    }

    /// Insert a fresh remote. Returns `false` when the id is already taken
    /// (`INSERT … ON CONFLICT(id) DO NOTHING` affects 0 rows) — the create
    /// handler maps that to a conflict rather than silently overwriting.
    ///
    /// # Errors
    ///
    /// Returns any error from the insert.
    pub fn insert_remote(&self, remote: &Remote) -> anyhow::Result<bool> {
        let row = RemoteRow::from(remote);
        let mut guard = self.conn.lock();
        let affected = diesel::insert_into(collector_remotes::table)
            .values(&row)
            .on_conflict(collector_remotes::id)
            .do_nothing()
            .execute(&mut *guard)?;
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
    /// Returns any error from the transaction or a corrupt stored config.
    pub fn update_remote(
        &self,
        id: &str,
        name: &str,
        tag: &str,
        config: &serde_json::Value,
    ) -> anyhow::Result<Option<Remote>> {
        let config_text = config.to_string();
        let mut guard = self.conn.lock();
        let row: Option<RemoteRow> = guard.transaction::<_, diesel::result::Error, _>(|conn| {
            let affected =
                diesel::update(collector_remotes::table.filter(collector_remotes::id.eq(id)))
                    .set((
                        collector_remotes::name.eq(name),
                        collector_remotes::tag.eq(tag),
                        collector_remotes::config.eq(&config_text),
                    ))
                    .execute(conn)?;
            if affected != 1 {
                // No such id — nothing was written; return `None` and let
                // the transaction commit (a no-op). The handler turns it
                // into `404 RemoteNotFound`.
                return Ok(None);
            }
            let updated = collector_remotes::table
                .filter(collector_remotes::id.eq(id))
                .select(RemoteRow::as_select())
                .first(conn)?;
            Ok(Some(updated))
        })?;
        row.map(Remote::try_from).transpose()
    }

    /// Remove a remote by id. Returns `true` iff a row was deleted; the
    /// handler maps `false` to `404 RemoteNotFound`.
    ///
    /// # Errors
    ///
    /// Returns any error from the delete.
    pub fn delete_remote(&self, id: &str) -> anyhow::Result<bool> {
        let mut guard = self.conn.lock();
        let affected =
            diesel::delete(collector_remotes::table.filter(collector_remotes::id.eq(id)))
                .execute(&mut *guard)?;
        Ok(affected == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(id: &str, added_at: &str) -> Remote {
        Remote {
            id: id.to_owned(),
            name: format!("Remote {id}"),
            tag: "fhir-r4".to_owned(),
            config: serde_json::json!({ "_tag": "fhir-r4", "rootUrl": "https://x" }),
            added_at: added_at.to_owned(),
        }
    }

    /// Running the migrations twice is a no-op the second time (diesel skips
    /// already-applied versions), the table exists, and the seed applied
    /// exactly once — so opening an existing database never re-seeds or errors.
    #[test]
    fn migrations_are_idempotent_and_seed_once() {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.run_pending_migrations(MIGRATIONS).unwrap();
        conn.run_pending_migrations(MIGRATIONS).unwrap();
        let seed_count: i64 = collector_remotes::table
            .count()
            .get_result(&mut conn)
            .expect("collector_remotes must exist after migrate");
        assert_eq!(seed_count, 1, "exactly the one seeded demo row");
    }

    /// Migration `0002` seeds the demo remote with the exact row the retired
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
            seeded.config,
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
        fresh.config = serde_json::json!({
            "_tag": "rexall",
            "username": "u",
            "password": "p",
            "nested": { "deep": [1, 2, 3] },
        });
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
        let new_config = serde_json::json!({ "_tag": "rexall", "username": "u" });
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
        let config = serde_json::json!({ "_tag": "fhir-r4" });
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

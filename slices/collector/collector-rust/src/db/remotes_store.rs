//! The `RemotesStore` handle — holds the app-wide r2d2 pool of Diesel
//! `SqliteConnection`s (`persistence_rust::DieselPool`) onto the shared database
//! file, applies the embedded collector migrations once on construction, and
//! exposes the `collector_remotes` CRUD the `/collector/remotes` handlers serve.
//! Queries check a connection out of the pool and load / write the domain
//! [`Remote`] directly — it carries the diesel derives, with [`JsonText`]
//! mapping `config` at the bind/read boundary.

use anyhow::Context;
use diesel::prelude::*;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use persistence_rust::DieselPool;

use crate::db::schema::collector_remotes;
use crate::domain::{Remote, RemoteError};
use shared_structures_rust::json_text::JsonText;

/// The collector migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`RemotesStore::new`]; diesel records applied
/// versions in its own `__diesel_schema_migrations` table, which is disjoint
/// from persistence-rust's namespaced `schema_migrations`, so the two migration
/// bookkeepers coexist in the shared database with no collision. Migration
/// `0002` seeds the demo FHIR remote the retired api_stubs stub used to
/// hardcode; because each migration runs only once per database, a user-deleted
/// seed stays deleted across upgrades.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

#[derive(Clone)]
pub struct RemotesStore {
    // The app-wide r2d2 pool onto the shared database file, built and owned by
    // the host (`persistence_rust::open_pool`). Diesel's connection API is
    // `&mut`, so each call checks a connection out of the pool rather than
    // sharing one behind a mutex; the pool (an `Arc` inside) makes the store
    // cheap to clone into the axum state. These are additional openers onto the
    // same file the host's rusqlite `persistence-rust::Connection` serves the
    // other slices from — SQLite permits multiple connections per file; the
    // pool's `busy_timeout` pragma rides out the brief write locks any
    // connection takes (see `persistence_rust::open_pool`).
    pool: DieselPool,
}

impl RemotesStore {
    /// Wrap the host-owned connection `pool` and apply pending collector
    /// migrations once, on a single checked-out connection. The host builds the
    /// app-wide pool (via `persistence_rust::open_pool`) on the same file its
    /// rusqlite connection opens for the other slices; both coexist (see the
    /// `pool` field).
    ///
    /// # Errors
    ///
    /// Returns an error if a connection can't be checked out of the pool or a
    /// migration fails.
    pub fn new(pool: DieselPool) -> anyhow::Result<Self> {
        let mut conn = pool
            .get()
            .context("failed to check out a connection to run collector migrations")?;
        conn.run_pending_migrations(MIGRATIONS)
            .map_err(|e| anyhow::anyhow!("failed to apply collector migrations: {e}"))?;
        drop(conn);
        Ok(Self { pool })
    }

    /// Build a store over a private in-memory database — for tests. Each call is
    /// an independent, freshly-migrated database. Uses
    /// `persistence_rust::open_in_memory_pool`, whose shared-cache URI keeps the
    /// pooled connections on one in-memory database (a naive `:memory:` pool
    /// gives each connection its own empty db).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory pool can't be built or migrated.
    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(persistence_rust::open_in_memory_pool()?)
    }

    /// Every remote, oldest first (ties broken by id so the order is total) —
    /// the `GET /collector/remotes` catalogue.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Backend`] on a checkout / read failure or a corrupt
    /// stored config.
    pub fn list_remotes(&self) -> Result<Vec<Remote>, RemoteError> {
        let mut conn = self
            .pool
            .get()
            .map_err(|e| RemoteError::backend("failed to check out a connection", e))?;
        collector_remotes::table
            .order((collector_remotes::added_at, collector_remotes::id))
            .select(Remote::as_select())
            .load(&mut conn)
            .map_err(|e| RemoteError::backend("list_remotes failed", e))
    }

    /// A single remote by id, or [`RemoteError::NotFound`] when absent — the
    /// `GET /collector/remotes/{id}` read. The store owns the not-found
    /// semantics so the handler is a straight `?`.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Backend`] on a checkout / read failure or a corrupt
    /// stored config.
    pub fn get_remote(&self, id: &str) -> Result<Remote, RemoteError> {
        let mut conn = self
            .pool
            .get()
            .map_err(|e| RemoteError::backend("failed to check out a connection", e))?;
        collector_remotes::table
            .find(id)
            .select(Remote::as_select())
            .first(&mut conn)
            .optional()
            .map_err(|e| RemoteError::backend("get_remote failed", e))?
            .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
    }

    /// Insert a fresh remote, or [`RemoteError::AlreadyExists`] when the id is
    /// already taken (`INSERT … ON CONFLICT(id) DO NOTHING` affects 0 rows) — a
    /// conflict rather than a silent overwrite.
    ///
    /// # Errors
    ///
    /// [`RemoteError::AlreadyExists`] when the id is taken;
    /// [`RemoteError::Backend`] on a checkout / insert failure.
    pub fn insert_remote(&self, remote: &Remote) -> Result<(), RemoteError> {
        let mut conn = self
            .pool
            .get()
            .map_err(|e| RemoteError::backend("failed to check out a connection", e))?;
        let affected = diesel::insert_into(collector_remotes::table)
            // `Remote`'s `config` uses `#[diesel(serialize_as)]`, which
            // consumes the value — diesel generates no borrowed `Insertable`
            // impl for the struct, so the insert takes a clone.
            .values(remote.clone())
            .on_conflict(collector_remotes::id)
            .do_nothing()
            .execute(&mut conn)
            .map_err(|e| RemoteError::backend("insert_remote failed", e))?;
        if affected == 1 {
            Ok(())
        } else {
            Err(RemoteError::AlreadyExists {
                id: remote.id.clone(),
            })
        }
    }

    /// Update an existing remote's `name` / `tag` / `config` (id and
    /// `added_at` are immutable) and return the resulting row, or
    /// [`RemoteError::NotFound`] when no remote has this id. A single
    /// `UPDATE … RETURNING` statement, so the write and the returned row are
    /// atomic — the row can't reflect a concurrent write, and a concurrent
    /// delete can't produce an updated-but-gone race.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Backend`] on a checkout / update failure or a corrupt
    /// stored config.
    pub fn update_remote(
        &self,
        id: &str,
        name: &str,
        tag: &str,
        config: &serde_json::Value,
    ) -> Result<Remote, RemoteError> {
        let mut conn = self
            .pool
            .get()
            .map_err(|e| RemoteError::backend("failed to check out a connection", e))?;
        diesel::update(collector_remotes::table.find(id))
            .set((
                collector_remotes::name.eq(name),
                collector_remotes::tag.eq(tag),
                collector_remotes::config.eq(JsonText::from(config.clone())),
            ))
            .returning(Remote::as_returning())
            .get_result(&mut conn)
            .optional()
            .map_err(|e| RemoteError::backend("update_remote failed", e))?
            .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
    }

    /// Remove a remote by id, or [`RemoteError::NotFound`] when no remote has
    /// this id.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Backend`] on a checkout / delete failure.
    pub fn delete_remote(&self, id: &str) -> Result<(), RemoteError> {
        let mut conn = self
            .pool
            .get()
            .map_err(|e| RemoteError::backend("failed to check out a connection", e))?;
        let affected = diesel::delete(collector_remotes::table.find(id))
            .execute(&mut conn)
            .map_err(|e| RemoteError::backend("delete_remote failed", e))?;
        if affected == 1 {
            Ok(())
        } else {
            Err(RemoteError::NotFound { id: id.to_owned() })
        }
    }
}

#[cfg(test)]
mod tests {
    use diesel::sqlite::SqliteConnection;

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
        let seeded = store.get_remote("fhir-demo").unwrap();
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
        store.insert_remote(&fresh).unwrap();
        let read = store.get_remote("r1").unwrap();
        assert_eq!(read, fresh);
    }

    #[test]
    fn insert_remote_conflicts_on_duplicate_id_without_overwriting() {
        let store = RemotesStore::open_in_memory().unwrap();
        let first = remote("dup", "2026-07-01T00:00:00.000Z");
        store.insert_remote(&first).unwrap();
        let second = remote("dup", "2026-07-02T00:00:00.000Z");
        assert!(matches!(
            store.insert_remote(&second),
            Err(RemoteError::AlreadyExists { id }) if id == "dup"
        ));
        // The original row is untouched.
        assert_eq!(store.get_remote("dup").unwrap(), first);
    }

    /// A row whose `config` TEXT is not valid JSON surfaces from a read as a
    /// [`RemoteError::Backend`] (diesel deserialization error), never a panic —
    /// so a future refactor can't quietly swap the `?` in [`JsonText`]'s
    /// `from_sql` for an `.unwrap()`.
    #[test]
    fn corrupt_stored_config_reads_as_a_backend_error_not_a_panic() {
        let store = RemotesStore::open_in_memory().unwrap();
        let mut conn = store.pool.get().expect("check out a connection");
        diesel::sql_query(
            "UPDATE collector_remotes SET config = 'not json' WHERE id = 'fhir-demo'",
        )
        .execute(&mut conn)
        .expect("corrupt the stored config");
        drop(conn);
        assert!(matches!(
            store.get_remote("fhir-demo"),
            Err(RemoteError::Backend { .. })
        ));
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
            .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.tag, "rexall");
        assert_eq!(updated.config, new_config);
        assert_eq!(updated.added_at, "2026-07-01T00:00:00.000Z");
        assert_eq!(store.get_remote("r1").unwrap(), updated);
    }

    #[test]
    fn update_remote_is_not_found_for_an_unknown_id() {
        let store = RemotesStore::open_in_memory().unwrap();
        let config = serde_json::json!({ "_tag": "fhir-r4" });
        assert!(matches!(
            store.update_remote("no-such-id", "n", "fhir-r4", &config),
            Err(RemoteError::NotFound { id }) if id == "no-such-id"
        ));
    }

    #[test]
    fn delete_remote_removes_the_row_and_reports_absence() {
        let store = RemotesStore::open_in_memory().unwrap();
        store
            .insert_remote(&remote("r1", "2026-07-01T00:00:00.000Z"))
            .unwrap();
        store.delete_remote("r1").unwrap();
        assert!(matches!(
            store.get_remote("r1"),
            Err(RemoteError::NotFound { .. })
        ));
        assert!(
            matches!(store.delete_remote("r1"), Err(RemoteError::NotFound { .. })),
            "second delete is a miss",
        );
    }
}

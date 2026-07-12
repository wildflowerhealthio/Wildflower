//! The `SqliteRemotesStore` adapter — the `SQLite` implementation of the
//! [`RemotesStore`](crate::domain::RemotesStore) port. Holds the app-wide r2d2
//! pool of Diesel `SqliteConnection`s (`persistence_rust::DieselPool`) onto the
//! shared database file, applies the embedded collector migrations once on
//! construction, and implements the port by delegating to the per-concern query
//! bodies in [`crate::db::remotes`]. Mirrors `tunnel-rust`'s `SqliteTunnelStore`.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use persistence_rust::DieselPool;

use crate::db::remotes;
use crate::domain::{Remote, RemoteError, RemotesStore};

/// The collector migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied once per database in [`SqliteRemotesStore::new`]; diesel records
/// applied versions in its own `__diesel_schema_migrations` table, which is
/// disjoint from persistence-rust's namespaced `schema_migrations`, so the two
/// migration bookkeepers coexist in the shared database with no collision.
/// Migration `0002` seeds the demo FHIR remote the retired api_stubs stub used
/// to hardcode; because each migration runs only once per database, a
/// user-deleted seed stays deleted across upgrades.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// The `SQLite` adapter for the [`RemotesStore`] port. Cheap to clone (the pool
/// is an `Arc` inside), so it drops straight into the axum state.
#[derive(Clone)]
pub struct SqliteRemotesStore {
    // The app-wide r2d2 pool onto the shared database file, built and owned by
    // the host (`persistence_rust::open_pool`). Diesel's connection API is
    // `&mut`, so each query checks a connection out of the pool rather than
    // sharing one behind a mutex; the pool (an `Arc` inside) makes the store
    // cheap to clone into the axum state. These are additional openers onto the
    // same file the host's rusqlite `persistence-rust::Connection` serves the
    // other slices from — SQLite permits multiple connections per file; the
    // pool's `busy_timeout` pragma rides out the brief write locks any
    // connection takes (see `persistence_rust::open_pool`).
    pool: DieselPool,
}

impl SqliteRemotesStore {
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

    /// The pool the sibling query module checks connections out of.
    fn pool(&self) -> &DieselPool {
        &self.pool
    }
}

/// The `SQLite` implementation of the port: each method is a thin delegation to
/// the matching query body in [`crate::db::remotes`], handing it the pool to
/// check a connection out of. The bodies live there so this file stays the
/// migration + pool handle, and the query SQL stays next to the row type it
/// maps. Every method returns the port's PRIMITIVE shape — absence as `None`,
/// insert/delete outcome as `bool` — leaving the `NotFound`/`AlreadyExists`
/// semantics to [`crate::domain::actions`].
impl RemotesStore for SqliteRemotesStore {
    fn list(&self) -> Result<Vec<Remote>, RemoteError> {
        remotes::list(self.pool())
    }

    fn get(&self, id: &str) -> Result<Option<Remote>, RemoteError> {
        remotes::get(self.pool(), id)
    }

    fn insert(&self, remote: &Remote) -> Result<bool, RemoteError> {
        remotes::insert(self.pool(), remote)
    }

    fn update(
        &self,
        id: &str,
        name: &str,
        tag: &str,
        config: &serde_json::Value,
    ) -> Result<Option<Remote>, RemoteError> {
        remotes::update(self.pool(), id, name, tag, config)
    }

    fn delete(&self, id: &str) -> Result<bool, RemoteError> {
        remotes::delete(self.pool(), id)
    }
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;
    use diesel::sqlite::SqliteConnection;

    use super::*;
    use crate::db::schema::collector_remotes;

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
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        let seeded = store.get("fhir-demo").unwrap().expect("seeded demo remote");
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
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        let mut fresh = remote("r1", "2026-07-01T00:00:00.000Z");
        fresh.tag = "rexall".to_owned();
        fresh.config = serde_json::json!({
            "_tag": "rexall",
            "username": "u",
            "password": "p",
            "nested": { "deep": [1, 2, 3] },
        });
        assert!(store.insert(&fresh).unwrap(), "fresh id inserts");
        let read = store.get("r1").unwrap().expect("just inserted");
        assert_eq!(read, fresh);
    }

    /// A duplicate id is the primitive `false` (0 rows affected) — the store no
    /// longer decides `AlreadyExists`, and the existing row is untouched.
    #[test]
    fn insert_reports_false_on_a_duplicate_id_without_overwriting() {
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        let first = remote("dup", "2026-07-01T00:00:00.000Z");
        assert!(store.insert(&first).unwrap());
        let second = remote("dup", "2026-07-02T00:00:00.000Z");
        assert!(!store.insert(&second).unwrap(), "duplicate id is false");
        // The original row is untouched.
        assert_eq!(store.get("dup").unwrap().as_ref(), Some(&first));
    }

    /// A row whose `config` TEXT is not valid JSON surfaces from a read as a
    /// [`RemoteError::Infrastructure`] (diesel deserialization error), never a
    /// panic — so a future refactor can't quietly swap the `?` in `JsonText`'s
    /// `from_sql` for an `.unwrap()`.
    #[test]
    fn corrupt_stored_config_reads_as_an_infrastructure_error_not_a_panic() {
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        let mut conn = store.pool.get().expect("check out a connection");
        diesel::sql_query(
            "UPDATE collector_remotes SET config = 'not json' WHERE id = 'fhir-demo'",
        )
        .execute(&mut conn)
        .expect("corrupt the stored config");
        drop(conn);
        assert!(matches!(
            store.get("fhir-demo"),
            Err(RemoteError::Infrastructure { .. })
        ));
    }

    /// Listing returns every row oldest-first, with the id as tiebreaker for
    /// same-instant rows — a total order, so the catalogue is deterministic.
    #[test]
    fn list_orders_by_added_at_then_id() {
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        assert!(store
            .insert(&remote("b-newer", "2026-07-02T00:00:00.000Z"))
            .unwrap());
        assert!(store
            .insert(&remote("z-old", "2026-07-01T00:00:00.000Z"))
            .unwrap());
        assert!(store
            .insert(&remote("a-old", "2026-07-01T00:00:00.000Z"))
            .unwrap());
        let ids: Vec<String> = store.list().unwrap().into_iter().map(|r| r.id).collect();
        // The 2026-06 seed sorts first; same-instant rows sort by id.
        assert_eq!(ids, vec!["fhir-demo", "a-old", "z-old", "b-newer"]);
    }

    /// `update` rewrites name/tag/config, preserves id + `added_at`, and returns
    /// the row as stored.
    #[test]
    fn update_rewrites_mutable_fields_and_keeps_added_at() {
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        assert!(store
            .insert(&remote("r1", "2026-07-01T00:00:00.000Z"))
            .unwrap());
        let new_config = serde_json::json!({ "_tag": "rexall", "username": "u" });
        let updated = store
            .update("r1", "Renamed", "rexall", &new_config)
            .unwrap()
            .expect("existing row updates");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.tag, "rexall");
        assert_eq!(updated.config, new_config);
        assert_eq!(updated.added_at, "2026-07-01T00:00:00.000Z");
        assert_eq!(store.get("r1").unwrap().as_ref(), Some(&updated));
    }

    /// An update addressed to an unknown id is the primitive `None` — the store
    /// no longer decides `NotFound`.
    #[test]
    fn update_is_none_for_an_unknown_id() {
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        let config = serde_json::json!({ "_tag": "fhir-r4" });
        assert_eq!(
            store.update("no-such-id", "n", "fhir-r4", &config).unwrap(),
            None,
        );
    }

    /// `delete` reports `true` for a removed row and `false` for a miss — the
    /// store no longer decides `NotFound`.
    #[test]
    fn delete_reports_true_then_false() {
        let store = SqliteRemotesStore::open_in_memory().unwrap();
        assert!(store
            .insert(&remote("r1", "2026-07-01T00:00:00.000Z"))
            .unwrap());
        assert!(store.delete("r1").unwrap(), "removed row is true");
        assert_eq!(store.get("r1").unwrap(), None);
        assert!(!store.delete("r1").unwrap(), "second delete is a miss");
    }
}

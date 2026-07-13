# Shared Diesel Pool Explanation

How the diesel-backed slices (today collector and tunnel) persist to the app's
one SQLite database. Like [polymorphic rows](./Polymorphic%20Rows%20Explanation.md),
this is a **convention, not a library**: the host builds a single connection pool
and hands it to each slice's store, and each store follows the same small shape by
hand. The pool primitive itself lives in `persistence-rust`
(`open_pool` / `DieselPool` in `persistence-rust/src/diesel_pool.rs`); this doc is
the cross-slice picture those slice stores share, so their comments can link here
instead of restating it.

## One file, two openers (diesel alongside rusqlite)

The Tauri host opens **one** rusqlite `persistence_rust::Connection` (the original
persistence primitive the pre-diesel slices write through) **and** builds **one**
`DieselPool` on the *same* database file, then shares the pool across every
diesel-backed slice. SQLite permits multiple connections per file, so the pool's
connections are simply additional openers onto it.

WAL is deliberately off repo-wide (see `Connection` in
`persistence-rust/src/connection.rs`), so SQLite allows only **one writer at a
time across all connections** to the file — the pool buys concurrent *reads*,
never concurrent writes.

**Accepted trade-off.** The pool's connections are *not* synchronized with the
`Arc<Mutex<rusqlite::Connection>>` the other slices write through, so a diesel
write can contend with a rusqlite write at the SQLite file-lock level — the old
"no cross-connection write contention" guarantee no longer holds. Both openers set
`busy_timeout = 5000` (the pool via `PragmaCustomizer`, matching the rusqlite
connection's pragmas), so a write rides out brief contention instead of failing
instantly with `SQLITE_BUSY`. For a single-user desktop app with short writes
that's ample; a pathological stalled write elsewhere can surface as a ≤5 s stall →
`SQLITE_BUSY` → 500. The composition root
(`apps/wildflower-tauri/src-tauri/src/lib.rs`) is where the pool is built and the
trade-off is accepted.

## The store holds the pool

Each slice's SQLite store (`SqliteRemotesStore`, `SqliteTunnelStore`) holds the
`DieselPool` — an `Arc` inside, so the store is cheap to clone into the axum state
— and implements the slice's domain persistence port. Diesel's connection API is
`&mut`, so each query **checks a connection out of the pool** rather than sharing
one behind a mutex; the per-concern query bodies live in sibling `db/*` modules,
so the store file stays the pool handle plus migration wiring.

## Migrations are namespaced per slice

Each slice embeds its own `migrations/` tree and applies it through
`persistence_rust::run_diesel_migrations` under its own namespace. Diesel's stock
`run_pending_migrations` bookkeeps applied versions in a single, un-namespaced
`__diesel_schema_migrations` keyed by version — and every slice starts at
`0001_initial_schema`, so two diesel slices sharing one database would collide and
the second slice's migration would be silently skipped. The namespaced runner
tracks `(namespace, version)` in `diesel_slice_migrations` so each slice's `0001`
is distinct. The full rationale is in
`persistence-rust/src/namespaced_migrations.rs`.

A table that predates the diesel move (like tunnel's `tunnel_settings`, once
created by the retired rusqlite `run_migrations` runner) uses **idempotent DDL**
(`CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE`) in its `0001` so the migration
is a no-op on an already-populated database while still creating the table on a
fresh one. A genuinely new table keeps plain `CREATE TABLE`.

## See also

- `persistence-rust/src/diesel_pool.rs` — `open_pool` / `open_in_memory_pool`,
  the pragmas, and the pool-cap rationale.
- `persistence-rust/src/namespaced_migrations.rs` — `run_diesel_migrations` and
  why the stock diesel harness collides.
- [Polymorphic Rows Explanation](./Polymorphic%20Rows%20Explanation.md) — the row
  shape *within* these tables, for records whose columns vary by kind.
- The implementations: collector's `SqliteRemotesStore`
  (`collector-rust/src/db/remotes_store.rs`) and tunnel's `SqliteTunnelStore`
  (`tunnel-rust/src/db/tunnel_store.rs`).

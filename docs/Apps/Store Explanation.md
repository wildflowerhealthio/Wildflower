# Apps Store Explanation

The implementation companion to the [Apps Explanation](./Explanation.md). That
doc explains the app model and privacy posture; this one explains how the
`apps-rust` store persists apps — the invariants the code leans on so the HTTP
handlers stay thin.

## Ports and adapters

The slice follows the same ports-and-adapters shape as `collector-rust`:

- **`AppsStore` (port)** — a domain trait (`domain/apps_store.rs`) speaking
  _primitive_ persistence over `AppRegistration`s. The insert/replace methods
  take a caller-built registration; the store assigns the display `position` on
  insert and uses everything else as given. Absence and non-permutation are
  **return-type signals** (`Option`) and a delete miss is `bool`; the only error
  it raises is the opaque `AppsError::Infrastructure`.
- **`SqliteAppsStore` (adapter)** — the `SQLite` implementation
  (`db/apps_store.rs`) over the app-wide diesel pool. The same file owns the
  `app_registrations` `table!` and its `AppUrlColumn`; each port method checks a
  connection out of the pool and runs its query on it, and the placement rewrite
  and create run their reads in-transaction through small private helpers.
- **`domain/capabilities/`** — the slice's _semantics_, one scope-gated
  capability per operation (`AppsReader`, `AppsCreator`, `AppsEditor`,
  `AppsDeleter`, `AppLauncher`). Each maps the store's primitive signals onto the
  semantic `AppsError` variants (`NotFound`, `InvalidHomeScreen`) and
  synthesizes the registration a create/replace persists, using the
  shared write-side validator and `AppPayload` input struct in
  `domain/actions/`. The admin HTTP handlers acquire a `Scoped<…>` capability and
  never touch the store directly; the launch handler looks the app up in the
  store itself and uses `AppLauncher` for the umbrella and per-app scope checks.
  The capabilities are unit-tested against an in-memory `FakeAppsStore`
  (`domain/test_fake.rs`) — no db, no HTTP.

Migrations are embedded diesel migrations (`apps-rust/migrations/`) applied once
in `SqliteAppsStore::new` under this slice's **namespace** (`"apps"`) via
`persistence_rust::run_diesel_migrations`, so the apps slice's `0001` and another
diesel slice's `0001` are tracked as distinct `(namespace, version)` rows and
never collide in diesel's stock `__diesel_schema_migrations`. The table
definition and the shipped apps' seeds are separate migrations, so the shipped
set versions independently of the schema.

## The store speaks registrations

Persistence is one `app_registrations` table over the app-wide diesel pool
(`persistence_rust::DieselPool`), and the domain's `AppRegistration` is
diesel-mapped straight to it. Reads are **typed diesel queries**: the catalogue
is `app_registrations ORDER BY position` into `AppRegistration`s, and a detail
read is the same row by id. `is_smart` is derived on the registration (from
`client_id`), not stored.

**A corrupt row surfaces as a typed read error.** A stored `url` that no longer
parses is rejected by the `AppUrlColumn` decode and surfaces as a _typed read
error_ (a logged 500 at the handler seam), never a partial registration or an
unsafe redirect target. The column decoder is the enforcement point; handlers
don't re-check it per call site.

## Transaction discipline

Three invariants let handlers avoid re-reading and re-validating around the
store:

1. **`RETURNING` on the writing statement.** Every create / replace hands back
   the stored registration via `RETURNING` on the statement that wrote it — no
   separate read-back. So a handler's response cannot drift from stored state,
   and it still re-decodes the stored `url` through the same column codec (a
   value that no longer round-trips surfaces as a typed error).
2. **`IMMEDIATE` in-transaction allocation.** The display `position` a create
   gets (`MAX(position) + 1`) is computed _inside_ the writing transaction. A
   mutator whose first act is a read (`insert_app`, `replace_placements`) runs
   under `BEGIN IMMEDIATE` so the write lock is taken up front: a concurrent
   create then waits on `busy_timeout` and re-reads a fresh value rather than
   reading the same `MAX` and racing to a `SQLITE_BUSY` or `UNIQUE` violation
   (SQLite denies a lock _upgrade_ immediately, without honoring
   `busy_timeout`). A content replace is a single `UPDATE … RETURNING` and stays
   on the default `DEFERRED`. `UNIQUE(position)` backstops regardless.
3. **Single writer of order + placement.** `position` and `on_homescreen` are
   written only by `replace_placements` (`PUT /home-screen`); a content replace
   never touches them. It validates the body is an exact permutation of the live
   registry _in the same `IMMEDIATE` transaction_ as the renumber (closing the
   check-then-write race), and moves every row to a disjoint negative range
   before renumbering so the per-row updates never transiently violate
   `UNIQUE(position)` (SQLite's UNIQUE is immediate, not deferrable). The
   permutation check itself is a pure domain function
   (`is_exact_registry_permutation`), fed the id set the store reads in that
   transaction.

The capabilities resolve an app before validating any field, so a bad `url` on an
unknown id is still a **404**. A create mints the id server-side; the primary key
rejects a collision on that minted id, which surfaces as a logged infrastructure
error naming the id, never a silent overwrite.

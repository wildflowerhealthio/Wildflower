# Diesel Persistence How-To

How to build a diesel-backed SQLite store for a Rust slice: mapping columns
diesel won't map on its own, pooling an in-memory database for tests, embedding
and namespacing migrations, and — only when a slice needs it — adding a
transaction seam so multi-statement logic stays in the pure domain.

This is the recipe side. For the cross-slice picture — why the host builds one
pool over one file, the WAL/single-writer trade-off, and how namespaced
migrations fit together — read the [Shared Diesel Pool
Explanation](./Shared%20Diesel%20Pool%20Explanation.md) first. The pool and
migration primitives live in `persistence-rust`
(`open_pool` / `open_in_memory_pool` / `DieselPool` in
`persistence-rust/src/diesel_pool.rs`, `run_diesel_migrations` in
`persistence-rust/src/namespaced_migrations.rs`); `collector`, `tunnel`, and
`gatekeeper` are the worked examples.

## Which diesel

The workspace pins `diesel = { version = "~2.3.11", features = ["sqlite",
"returning_clauses_for_sqlite_3_35", "r2d2"] }` (root `Cargo.toml`). Even though
diesel 2.3 ships native SQLite `Json` support, the convention here maps JSON
columns through a `Text` newtype (below) rather than the native type — the stored
representation is compact JSON in a STRICT `TEXT` column, and a slice opts into
the shared mapping through a feature rather than every slice re-deriving it. The
`chrono` feature is enabled per-slice (only `gatekeeper` needs it today).

## JSON columns: map a `serde_json::Value` through a `Text` newtype

Store a `serde_json::Value` field with the shared
`shared_structures_rust::json_text::JsonText` newtype
(`shared-structures-rust/src/json_text.rs`, behind the `diesel-json-text`
feature). It is a `#[derive(AsExpression, FromSqlRow)] #[diesel(sql_type =
Text)]` newtype with hand-written `ToSql`/`FromSql<Text, Sqlite>`: writes emit
compact JSON via `to_string()`, reads `serde_json::from_str` the stored TEXT
(corrupt TEXT surfaces as a diesel deserialization error, never a panic).

Enable it on the slice's dependency and plug it in on the plain field:

```toml
# <slice>-rust/Cargo.toml
shared-structures-rust = { path = "...", features = ["diesel-json-text"] }
```

```rust
// The field stays a plain serde_json::Value; the newtype only rides the wire
// to/from the TEXT column. (collector-rust/src/domain/remote.rs)
#[diesel(serialize_as = JsonText, deserialize_as = JsonText)]
pub config: serde_json::Value,
```

Two gotchas that bite every `serialize_as` field:

- **`serialize_as` converts via `Into`, which consumes the value**, so diesel
  generates no borrowed `Insertable` impl for the row struct — `.values(&model)`
  won't compile; pass an owned `.values(model.clone())`
  (`collector-rust/src/db/remotes.rs`).
- **The newtype must be `pub`** (E0446): it appears in the public
  `Queryable`/`Insertable` impls the row type's derives generate, so it must be
  at least as visible as the row type.

Note the unrelated `persistence_rust::JsonColumn<T>`
(`persistence-rust/src/json_column.rs`) is the **rusqlite** JSON newtype for the
pre-diesel stores — not this pattern. Don't reach for it in a diesel slice.

## Typed inner columns (Vec, Url, enum)

The same `sql_type = Text` newtype shape extends to any typed inner —
`Vec<String>`, `Url`, a domain enum — for **non-`Option`** fields.
`gatekeeper-rust/src/db/shared.rs` generates these with two macros so a
`db/<concern>.rs` gets a mapping after one `use`:

- `json_text_column!(Name, Inner)` — binds `Inner` as compact JSON in a TEXT
  column (e.g. `JsonStrings(Vec<String>)`).
- `text_enum_column!(Enum)` — binds a strum-stringified domain enum straight
  through (the enum carries the `AsExpression`/`FromSqlRow` derives on its
  `domain` definition; the macro adds only `FromSql`/`ToSql`). Used for
  `GrantType`, `RequestStatus`.

`UrlText(Url)` (also in `db/shared.rs`) is the hand-written equivalent for a
`Url` inner. As with `JsonText`, reads re-parse, so an out-of-domain stored
value is a deserialization error rather than a panic.

## Nullable fields whose inner is foreign: mirror the table with a private row struct

`#[diesel(serialize_as = X, deserialize_as = X)]` works for a plain field but
**not** for a nullable one whose inner type is foreign. A field like
`Option<Url>` would need `impl From<Option<UrlText>> for Option<Url>` (and the
reverse), and `Option` is neither local nor `#[fundamental]`, so the orphan rule
rejects it.

Don't fight it per-field. Give that one table a **private** `#[derive(Queryable,
Selectable, Insertable)]` row struct in `db/` whose fields **are** the wrapper
types (`Option<UrlText>`, `Option<JsonStrings>` — the blanket `Option<T: ToSql /
FromSql>` impls cover `Nullable`), and convert to/from the domain type with
`From` at the query boundary. In gatekeeper only `authorization_requests` needs
this (`gatekeeper-rust/src/db/authorization_requests.rs`, the private `Row`
struct + its two `From` impls); every other table maps its domain struct
directly.

Two adjacent facts:

- **`chrono` maps timestamps natively on SQLite.** With diesel's `chrono`
  feature, `DateTime<Utc>` / `Option<DateTime<Utc>>` map to `TimestamptzSqlite`
  (text `%F %T%.f%:z`, whose lexicographic order stays chronological) with no
  wrapper. Enable the feature on the slice's diesel dep
  (`gatekeeper-rust/Cargo.toml`).
- **`thiserror` claims a field literally named `source`** as the structured
  error source and requires it to `impl Error`. An error variant that wants a
  plain `source: String` (context string, not a nested error) must hand-write
  `Display`/`Error` instead of `#[derive(thiserror::Error)]` — see
  `gatekeeper-rust/src/domain/gatekeeper_error.rs`'s `Infrastructure` variant.

## Pool an in-memory database for tests

A plain r2d2 pool over `:memory:` gives every pooled connection its **own**
private database, so a migration on one checkout is invisible to the next — tests
that pass on a single connection break the moment the store checks out a second.

Use `persistence_rust::open_in_memory_pool()` (public, non-test —
`persistence-rust/src/diesel_pool.rs`). It builds the pool over a shared-cache
URI `file:<unique>?mode=memory&cache=shared` (unique per pool via an
`AtomicU64`, so tests stay isolated) and relies on r2d2's default `min_idle ==
max_size` to keep a connection **resident** — a shared-cache in-memory database
exists only while ≥1 connection to it is open, so the resident connection keeps
it alive for the pool's lifetime. Both openers apply `busy_timeout = 5000` (and
`foreign_keys = ON`) via a `PragmaCustomizer`.

For an on-disk pool test, prefer a `tempfile::tempdir()` path over `:memory:` so
the cross-connection round-trip actually exercises one shared file. To read a
pragma back in a test, query the table-valued pragma function with a
`QueryableByName` scalar:

```rust
// persistence-rust/src/diesel_pool.rs (applies_pragmas_on_acquire)
#[derive(QueryableByName)]
struct Scalar {
    #[diesel(sql_type = BigInt)]
    value: i64,
}
diesel::sql_query("SELECT timeout AS value FROM pragma_busy_timeout()")
    .get_result::<Scalar>(&mut conn)?;
```

## Embed and namespace migrations

Each slice embeds its own `migrations/` tree and applies it through
`persistence_rust::run_diesel_migrations(conn, namespace, source)` under its own
namespace — **never** diesel's stock `run_pending_migrations`. The stock harness
bookkeeps applied versions in one un-namespaced `__diesel_schema_migrations`
keyed by version, and every slice starts at `0001_initial_schema`, so a second
diesel slice sharing the app database would see `0001` already applied and
**silently skip its own migration**. The namespaced runner tracks `(namespace,
version)` in `diesel_slice_migrations`, applying each migration and its
bookkeeping row in one transaction. Call it with a per-slice constant:

```rust
// collector-rust/src/db/remotes_store.rs, tunnel-rust/src/db/tunnel_store.rs
persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
```

**A genuinely new table** uses plain `CREATE TABLE` in its `0001` (collector's
`collector_remotes`). **A table that predates the diesel move** — one the retired
rusqlite `run_migrations` runner already created on shipped databases — must use
**idempotent DDL** (`CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` for a
seeded singleton) so `0001` is a no-op on an upgraded database while still
creating the table on a fresh one (tunnel's `tunnel_settings`,
`tunnel-rust/migrations/0001_initial_schema/up.sql`). The
[Shared Diesel Pool Explanation](./Shared%20Diesel%20Pool%20Explanation.md#migrations-are-namespaced-per-slice)
covers why both bookkeepers coexist; `persistence-rust/src/namespaced_migrations.rs`
carries the full rationale and a regression test running two same-version fixture
trees under different namespaces.

## Add a transaction seam only when compound operations need one

A CRUD-only store (collector, tunnel) needs **no** transaction seam — each query
checks out a connection and autocommits. Reach for a seam only when a slice has
multi-statement operations that must be atomic (read-merge-write, delete-both-
then-expire, a three-state consume) and you don't want that business logic
trapped inside the SQLite adapter and re-implemented in the in-memory fake.

Gatekeeper is the worked example
(`gatekeeper-rust/src/domain/gatekeeper_store/{mod,store,tx}.rs`). Split the port
into two traits:

- **`GatekeeperTx`** — single-statement primitives taking `&mut self`
  (`tx.rs`).
- **`GatekeeperStore`** — a seam with a GAT `type Tx<'a>: GatekeeperTx` plus
  `with_connection` / `transaction` / `immediate_transaction`, each taking
  `impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>` (`store.rs`).

Compose the compound operations in `domain/capabilities/*` inside those
closures, so their logic runs against the fast in-memory fake as well as SQLite.
Load-bearing details:

- **Pass closures, not fn-item paths.** The elided `&mut Self::Tx<'_>` bound is
  higher-ranked (`for<'a>`), so `|tx| tx.foo()` unifies where a bare
  `GatekeeperTx::foo` does not.
- **`immediate_transaction` (BEGIN IMMEDIATE) takes the write lock at read
  time.** A read-merge-write (scope-union grant upsert) must use it, or a
  concurrent writer can lose the union; a plain `transaction` is deferred and
  regresses silently. Gatekeeper's consent upserts call `immediate_transaction`
  (`domain/capabilities/consents/{oauth,device}.rs`); the revoke path uses
  `transaction` (`domain/capabilities/grants.rs`).
- **diesel's `transaction`/`immediate_transaction` require `E: From<diesel::result::Error>`**
  (BEGIN/COMMIT can fail even when the closure maps its own query errors), so add
  `impl From<diesel::result::Error> for GatekeeperError` in the `db` layer
  (`db/gatekeeper_store.rs`) to keep `domain::error` diesel-free.
- **The concrete `Tx` type is public interface.** `type Tx<'a>` on a `pub` trait
  makes the SQLite adapter's `SqliteGatekeeperTx` a public type (E0446) — it must
  be `pub`.
- **Keep the default methods** (each `self.with_connection(|tx| tx.op())`) so
  lone reads stay autocommit (no write lock) and existing single-statement call
  sites are untouched.
- **The fake rolls back by snapshotting** its maps before
  `transaction`/`immediate_transaction` and restoring on `Err`
  (`domain/test_fake/`). It can't model real lock contention, so concurrency
  tests (lost-update, guarded-update) stay SQLite-backed while the
  orchestration/merge logic gains fast fake coverage in `domain/capabilities`.

## See also

- [Shared Diesel Pool Explanation](./Shared%20Diesel%20Pool%20Explanation.md) —
  the one-pool-per-file picture, the write-contention trade-off, and the
  per-slice migration namespacing this how-to's recipes plug into.
- [OpenAPI Spec Drift How-To](../Effect/OpenAPI%20Spec%20Drift%20How-To.md) —
  when a stored JSON column is also served on the wire, spec its field
  `#[schema(value_type = Value)]`.
- `persistence-rust/src/diesel_pool.rs` and
  `persistence-rust/src/namespaced_migrations.rs` — the pool and migration
  primitives, with their rationale in doc comments.

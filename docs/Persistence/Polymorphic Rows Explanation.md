# Polymorphic Rows Explanation

How a diesel slice stores a record whose shape varies by kind, and how that
storage reaches the wire as a discriminated union. Gatekeeper's **grants** are
the worked example: an authorization-code grant and a device grant share most of
their columns but each carries its own payload (`redirect_uri` or
`device_name`).

## The problem

Some rows are a common core plus a per-kind payload. A flat table forces every
kind's columns to be nullable — the type system then can't say "a device grant
_always_ has a device name", so every reader re-checks invariants the schema
should have guaranteed. A single JSON blob column hides the payload from SQL
entirely (no per-kind `UNIQUE`, no `CHECK`, no indexable columns).

Two shapes keep every column `NOT NULL` where it should be:

- **Table per concrete kind** — each kind's table carries ALL its columns,
  shared and payload alike, and cross-kind reads go through a `UNION ALL` view.
- **Shared parent + per-kind child** (class-table-inheritance) — a parent table
  holds the shared core and a `kind` discriminator, and each kind's payload lives
  in a child table keyed `id … REFERENCES parent(id) ON DELETE CASCADE`.

Reach for whichever fits the access pattern; neither is a default to reach for
reflexively.

## Grants: one table per concrete kind

Every grant write and keyed lookup names one kind — `/authorize` upserts an
authorization-code grant keyed `(client_id, redirect_uri)`, the device flow a
device grant keyed `(client_id, device_name)` — and only the Owner UI's access
index and the by-id lookups span both. So grants take **one table per concrete
kind**: `authorization_code_grants` and `device_grants` each carry all their
columns, every one `NOT NULL` where it should be, and each kind's upsert key is a
`UNIQUE` on its own table (gatekeeper migration `0001_gatekeeper_schema`).
Upserts and keyed lookups are single-table statements.

The cross-kind reads go through a `grants` SQL VIEW (migration `0002_grants_view`):
a `UNION ALL` of the two tables projecting the shared columns, a `grant_type` tag,
and each kind's payload column, NULL for the other kind. Ids are UUIDs minted at
insert, so they stay unique across the tables and a by-id read through the view
returns at most one row. The view sits in its own migration because a projection
is edited far more often than the tables it reads.

The price is shared-column duplication, and it shows up only in the DDL and the
view definition, never in a query or an invariant.

## The domain: one struct per kind, shared behaviour

The domain is one plain struct per kind (`AuthorizationCodeGrant`,
`DeviceGrant`), each owning all of its fields and diesel-mapped straight to its
own table. The kinds share **behaviour**, not structure: the `CumulativeConsent`
trait is the re-approval rule both follow. Single-kind operations never touch a
polymorphic value; concrete-typed inserts live with their kind, so the store never
inspects a union to pick a table. See `gatekeeper-rust/src/domain/grant.rs` and
`gatekeeper-rust/src/db/grants/`.

## The wire: one discriminated union

A thin `Grant` enum is the wire/list seam: its internally-tagged serde emits a
`grantType`-tagged union, so a client decodes one union and narrows on the tag.

- **Rust** — an internally-tagged serde enum over the per-kind structs. Add
  per-variant serde tests when the surface is undocumented (no drift test to
  catch a slip).
- **TypeScript** — a `Schema.Union` of one `Schema.Struct` per variant, each
  pinning its tag with `Schema.Literal`; consumers narrow with `Extract<T, {
grantType: 'x' }>` (types) or effect `Match.value` on the tag (rendering). See
  `gatekeeper-core`'s `access-management.ts`.

## When the shared parent fits instead

When the shared core is queried as one thing far more than the kinds are
touched apart — one list ordered across every kind, say — a shared parent pays
for itself: the parent is the list, and each child holds only its kind's
`NOT NULL` payload. It costs a cross-table transaction on every write, and an
invariant no SQLite schema can enforce: a parent of kind K must have its row in
child table K. Writes then build the parent+child pair together and insert both
in one transaction, and reads treat a missing child as a typed infrastructure
error rather than a partial value.

## See also

- [Shared Diesel Pool Explanation](./Shared%20Diesel%20Pool%20Explanation.md) —
  how slices share one SQLite database.
- [OpenAPI Spec Drift How-To](../Effect/OpenAPI%20Spec%20Drift%20How-To.md) — for a
  union on a _documented_ surface, how the Rust ⇄ TS halves are drift-checked.

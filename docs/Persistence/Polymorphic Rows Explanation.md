# Polymorphic Rows Explanation

How Wildflower stores a record whose shape varies by kind — an app that is
system / cloud / self-hosted — and how that one storage shape reaches the wire
as a discriminated union. This is a **convention, not a library**: there is no
shared helper in `persistence-rust`; a slice writes the small pattern by hand,
and this doc is the single description. Its implementation today is
[apps](../Apps/Explanation.md). Gatekeeper's grants used to be the second one
and deliberately **left the pattern** for one table per concrete kind — see
[the alternative](#the-alternative-one-table-per-concrete-kind) below for what
it moved to and when to prefer which.

## The problem

Some rows are a common core plus a per-kind payload. A flat table forces every
kind's columns to be nullable — the type system then can't say "a cloud app
_always_ has a URL", so every reader re-checks invariants the schema should have
guaranteed. A single JSON blob column hides the payload from SQL entirely (no
per-kind `UNIQUE`, no `CHECK`, no indexable columns).

## The shape

A **parent registry table** holds the shared columns plus a `TEXT` discriminator
constrained by a `CHECK`. Each kind gets a **child table** keyed
`id … REFERENCES parent(id) ON DELETE CASCADE`, holding exactly that kind's
`NOT NULL` columns. A row is a parent plus the one child its discriminator names
(a kind may also carry no child at all — apps' `system` kind).

```sql
CREATE TABLE apps (              -- parent: the shared core + discriminator
    id         TEXT PRIMARY KEY,
    -- … shared columns (name, position, enabled, …) …
    provenance TEXT NOT NULL CHECK (provenance IN ('system', 'self-hosted', 'cloud'))
);
CREATE TABLE cloud_apps (                          -- one child per kind
    id  TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    url TEXT NOT NULL
    -- … the cloud kind's NOT NULL payload …
);
CREATE TABLE self_hosted_apps (
    id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    port      INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    subdomain TEXT NOT NULL
    -- … the self-hosted kind's NOT NULL payload …
);
```

The full schema is `apps-rust/src/migrations/004_apps_registry.sql` (the
`system` kind carries no child at all).

### Why child tables, not nullable columns

Each variant's columns stay `NOT NULL` in their own table — the invariant lives
in the schema, not in prose. Per-variant `UNIQUE` indexes (apps' `subdomain`)
can't be expressed across a parent+child JOIN, so they live on the child.
`ON DELETE CASCADE` makes deleting the parent delete the payload.

## The invariants and how they're held

**Parent implies child.** A `cloud`/`self-hosted` parent must have its child
row. Nothing in SQLite enforces "parent of kind K has a row in table K", so two
rules carry it:

- **Writes are one transaction, parent first.** Insert the parent, then the
  child, then commit — never a parent without its child. See apps'
  `db/writes.rs`.
- **Reads fail typed on a missing child.** One `SELECT` with a `LEFT JOIN` per
  child decodes the whole row; the decoder dispatches on the discriminator and
  reads the child columns its kind needs through a helper that maps a `NULL`
  (LEFT JOIN found no child) to a typed error naming the column — never a
  partial value. See `app_from_row` / `get_child` in `apps-rust/src/db/reads.rs`.

**The discriminator is the variant, not a separate field.** The Rust domain is a
struct of shared fields plus a payload-carrying enum; a `provenance()` accessor
_derives_ the stored discriminator from the variant, so a row can't claim one
kind while carrying another's payload. See `apps-rust/src/domain/app.rs`
(`AppKind`).

## The wire: one discriminated union

The same storage shape reaches the wire as an **internally-tagged union** — the
tag plus the matching variant's fields alongside the shared fields — so a client
decodes one union and narrows on the tag:

- **Rust** — serialize the union with an internally-tagged serde enum. apps
  projects a separate wire type (`AppListEntry`, `#[serde(tag = "provenance")]`)
  from the domain via a `From` impl; tagging the domain type directly is also
  fine — projecting keeps the domain serde-free, tagging is less code. Add
  per-variant serde tests when the surface is undocumented (no drift test to
  catch a slip).
- **TypeScript** — a `Schema.Union` of one `Schema.Struct` per variant, each
  pinning its tag with `Schema.Literal` and adding its own fields. Consumers
  narrow with `Extract<T, { tag: 'x' }>` (types) or effect `Match.value` on the
  tag (rendering). See `apps-core/.../schemas.ts` (`AppListEntrySchema`).

## The alternative: one table per concrete kind

Class-table inheritance earns its two-table write when the shared core is
**queried as one thing more often than each kind is handled alone** — apps'
homescreen is one `ORDER BY position` list with a dense-position invariant
across all kinds, so the parent registry IS the feature.

When the kinds mostly live apart — every write and keyed lookup names one kind,
and only a couple of reads span them — the parent buys nothing and costs a
cross-table transaction on every write plus a parent-implies-child invariant no
schema can enforce. Gatekeeper's grants are that case, and they moved to **one
table per concrete kind**: `authorization_code_grants` and `device_grants` each
carry ALL columns (shared and payload alike, every one `NOT NULL` where it
should be), upserts and keyed lookups are single-table statements, and the few
cross-kind reads go through a `grants` SQL VIEW (`UNION ALL` of the tables —
shared columns + a kind tag + each kind's payload column, NULL for the other
kind). Ids are UUIDs minted at insert, so they stay unique across the tables and
a by-id read through the view is unambiguous. The domain is one plain struct per
kind sharing *behaviour* through a trait (never field-getter bags), with a thin
enum at the wire/list seam keeping the same internally-tagged union. See
`gatekeeper-rust/src/db/grants.rs` and `src/domain/grant.rs`, and migration
`0001_gatekeeper_schema` for the view.

The shared-column duplication is the price; it shows up only in DDL and in the
view definition, not in any query or invariant.

## See also

- [Apps Explanation](../Apps/Explanation.md) — the taxonomy the reference
  implementation stores.
- [OpenAPI Spec Drift How-To](../Effect/OpenAPI%20Spec%20Drift%20How-To.md) — for
  a union on a _documented_ surface, how the Rust ⇄ TS halves are drift-checked.
- gatekeeper's table-per-kind grants: `gatekeeper-rust/src/db/grants.rs`,
  `src/domain/grant.rs`, `gatekeeper-core/src/http-api-definition/access-management.ts`.

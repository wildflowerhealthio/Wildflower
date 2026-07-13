# Polymorphic Rows Explanation

How Wildflower stores a record whose shape varies by kind — an app that is
system / cloud / self-hosted, a grant that is an authorization-code consent or a
device pairing — and how that one storage shape reaches the wire as a
discriminated union. This is a **convention, not a library**: there is no shared
helper in `persistence-rust`; each slice writes the same small pattern by hand,
and this doc is the single description they share. Its live implementation is
**gatekeeper grants** and the **apps registry**. (The apps slice briefly used a
table-per-struct variant — one standalone table per kind, no parent, issue 350 —
but **returned to this parent+child shape**: its `app_registrations` parent is a real
domain object — the global id space, the shared catalogue facts, and the
homescreen-placement aggregate — not the abstract "app base class" the earlier
objection was to. Its discriminator is `kind` (`AppKind`), distinct from grants'
`grantType`. See [Apps Explanation](../Apps/Explanation.md) §"Data
model". The two slices differ on the wire — grants a tagged union, apps a uniform
list + per-kind detail — see §"The wire".)

## The problem

Some rows are a common core plus a per-kind payload. A flat table forces every
kind's columns to be nullable — the type system then can't say "a cloud app
_always_ has a URL" or "a device grant _always_ has a device name", so every
reader re-checks invariants the schema should have guaranteed. A single JSON blob
column hides the payload from SQL entirely (no per-kind `UNIQUE`, no `CHECK`, no
indexable columns).

## The shape

A **parent registry table** holds the shared columns plus a `TEXT` discriminator
constrained by a `CHECK`. Each kind gets a **child table** keyed
`id … REFERENCES parent(id) ON DELETE CASCADE`, holding exactly that kind's
`NOT NULL` columns. A row is a parent plus the one child its discriminator names.

```sql
CREATE TABLE grants (            -- parent: the shared core + discriminator
    id         TEXT PRIMARY KEY,
    -- … shared columns (client_id, scopes, granted_at, …) …
    grant_type TEXT NOT NULL CHECK (grant_type IN ('authorization_code', 'device_code'))
);
CREATE TABLE authorization_code_grants (           -- one child per kind
    id           TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
    client_id    TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    UNIQUE (client_id, redirect_uri)               -- per-variant invariant
);
CREATE TABLE device_grants (
    id          TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
    client_id   TEXT NOT NULL,
    device_name TEXT NOT NULL,
    UNIQUE (client_id, device_name)
);
```

### Why child tables, not nullable columns

Each variant's columns stay `NOT NULL` in their own table — the invariant lives
in the schema, not in prose. Per-variant `UNIQUE` indexes (the grant upsert keys)
can't be expressed across a parent+child JOIN, so they live on the child; that's
why **`client_id` is denormalized onto the children** even though the parent
already has it. `ON DELETE CASCADE` makes deleting the parent delete the payload.

## The invariants and how they're held

**Parent implies child.** A `cloud`/`device`/… parent must have its child row.
Nothing in SQLite enforces "parent of kind K has a row in table K", so two rules
carry it:

- **Writes are one transaction, parent first.** Insert the parent, then the
  child, then commit — never a parent without its child. `client_id` is written
  identically to both in that transaction, so `child.client_id == parent.client_id`
  holds by construction. See `upsert_grant` / `upsert_device_grant` / `create_grant`
  in `gatekeeper-rust/src/db/grants.rs`.
- **Reads fail typed on a missing child.** One `SELECT` with a `LEFT JOIN` per
  child decodes the whole row; the decoder dispatches on the discriminator and
  reads the child columns its kind needs through a helper that maps a `NULL`
  (LEFT JOIN found no child) to a typed error naming the column — never a partial
  value. See `grant_from_row` / `get_child` in `db/grants.rs`.

**The discriminator is the variant, not a separate field.** The Rust domain is a
struct of shared fields plus a payload-carrying enum; a `grant_type()` /
`provenance()` accessor _derives_ the stored discriminator from the variant, so a
row can't claim one kind while carrying another's payload:

```rust
pub struct Grant { /* shared fields */ pub kind: GrantKind }
pub enum GrantKind {
    AuthorizationCode { redirect_uri: UriColumn },
    DeviceCode { device_name: String },
}
impl GrantKind { pub fn grant_type(&self) -> GrantType { /* variant → column value */ } }
```

Mirror in `gatekeeper-rust/src/domain/grant.rs`. (apps applies the same
"discriminator is the variant" idea in its `App` enum, whose variants wrap the
per-kind detail types — the variant _is_ the `kind`, and its `AppRegistration`
carries the `kind` column value.)

## The wire

How a polymorphic row reaches the wire is a per-slice choice, not fixed by the
storage shape:

- **gatekeeper grants — one internally-tagged union.** The stored parent+child
  reaches the wire as a single tagged union: the tag (`grantType`) plus the
  matching variant's fields alongside the shared fields, so a client decodes one
  union and narrows on the tag. Rust tags the domain `Grant` directly
  (`#[serde(flatten)]` a `#[serde(tag = "grantType")]` `GrantKind`); TypeScript is
  a `Schema.Union` of one `Schema.Struct` per variant, each pinning its tag with
  `Schema.Literal`, narrowed with `Extract<T, { tag: 'x' }>` / effect
  `Match.value`. The `/access/*` surface is undocumented, so add per-variant serde
  tests (no drift test guards it). See
  `gatekeeper-core/.../access-management.ts` (`GrantSchema`).
- **apps registry — a uniform list + per-kind detail (no union).** The apps
  catalogue is _not_ a tagged union: `GET /apps` returns a **uniform**
  `AppRegistration[]` (the shared registration fields plus a `kind` tag, nothing
  to narrow), and the per-kind payload is read on a **per-kind detail** endpoint
  (`/cloud-apps/{id}` etc.) whose shape is flat (registration fields + that kind's
  payload). Projecting the catalogue to a flat, non-narrowing shape — and moving
  the payload off the list onto per-kind resources — is what the drift-checked
  `apps-core/.../schemas.ts` (`AppRegistrationSchema`, `CloudAppDetailSchema`, …)
  pins. Either shaping is fine; pick by whether consumers must narrow.

## Migrating a flat table into this shape

When the flat table already holds real rows (unlike apps, which dropped and
reseeded), copy in one migration: rename the old table aside, create the parent
and children, `INSERT … SELECT` the shared columns into the parent (**parent
first** so the child FK resolves), then `INSERT … SELECT` each row's payload into
its child, then drop the old table. See
`gatekeeper-rust/src/migrations/010_polymorphic_grants.sql`.

## See also

- [Apps Explanation](../Apps/Explanation.md) — the `kind` taxonomy this pattern
  stores, and its uniform-list + per-kind-detail wire shaping.
- [OpenAPI Spec Drift How-To](../Effect/OpenAPI%20Spec%20Drift%20How-To.md) — for
  a union on a _documented_ surface, how the Rust ⇄ TS halves are drift-checked.
- gatekeeper's grant storage: `gatekeeper-rust/src/db/grants.rs`,
  `src/domain/grant.rs`, `gatekeeper-core/src/http-api-definition/access-management.ts`.

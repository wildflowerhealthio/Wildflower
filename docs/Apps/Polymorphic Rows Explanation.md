# Polymorphic Rows Explanation (apps)

How the **apps** slice stores a record whose shape varies by kind — an app that
is system / cloud / self-hosted — and how that one storage shape reaches the wire
as a discriminated union.

This is **one approach, not a house convention.** Apps takes it because its
shared core is queried as one thing (the homescreen list). Gatekeeper's grants
faced the same "columns vary by kind" problem and deliberately took the _other_
approach — one table per concrete kind behind a `UNION ALL` view (see
[Contrast: grants' table-per-kind](#contrast-grants-table-per-kind)). Reach for
whichever fits the access pattern; neither is a default to reach for reflexively.

## The problem

Some rows are a common core plus a per-kind payload. A flat table forces every
kind's columns to be nullable — the type system then can't say "a cloud app
_always_ has a URL", so every reader re-checks invariants the schema should have
guaranteed. A single JSON blob column hides the payload from SQL entirely (no
per-kind `UNIQUE`, no `CHECK`, no indexable columns).

## Apps' shape: a shared registration + a per-kind configuration

An authoritative **`app_registrations`** table holds the shared core — the global
id space, the catalogue fields, the homescreen placement (`position` /
`on_homescreen`) — plus a `kind` discriminator. Each kind gets its own
**configuration table** keyed `id … REFERENCES app_registrations(id) ON DELETE
CASCADE`, holding exactly that kind's `NOT NULL` payload. A whole app is a
registration plus the one configuration its `kind` names (a kind may carry no
payload beyond the shared row — apps' `system` kind is an ordinary seeded
registration whose launch template lives in `system_app_configurations`).

```sql
CREATE TABLE app_registrations (        -- the shared core + discriminator
    id   TEXT PRIMARY KEY,
    -- … shared columns (name, position, on_homescreen, …) …
    kind TEXT NOT NULL CHECK (kind IN ('system', 'self-hosted', 'cloud'))
);
CREATE TABLE cloud_app_configurations (          -- one per kind
    id  TEXT PRIMARY KEY REFERENCES app_registrations(id) ON DELETE CASCADE,
    url TEXT NOT NULL
);
CREATE TABLE self_hosted_app_configurations (
    id   TEXT PRIMARY KEY REFERENCES app_registrations(id) ON DELETE CASCADE,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535)
    -- … the self-hosted kind's NOT NULL payload …
);
```

The schema is apps' `0001_app_registrations` migration. Each variant's columns
stay `NOT NULL` in their own table — the invariant lives in the schema, not in
prose — and per-kind `UNIQUE` indexes live on the configuration table (they can't
be expressed across the registration+configuration JOIN). `ON DELETE CASCADE`
makes deleting the registration delete the payload.

## The invariants and how they're held

**Registration implies configuration.** A `cloud`/`self-hosted` registration must
have its configuration row. Nothing in SQLite enforces "a registration of kind K
has a row in table K", so two rules carry it:

- **Writes synthesize the pair in the action and insert it in one transaction.**
  The `domain/actions/` layer builds the `(registration, configuration)` pair; the
  `db/` layer inserts both together, so a registration never persists without its
  configuration.
- **Reads fail typed on a missing configuration.** A registration read plus a
  typed per-kind configuration read; a configuration absent for its kind is a
  logged infrastructure error naming the row, never a partial value.

**The discriminator is the variant, not a separate field.** The Rust domain deals
in `AppRegistration` (the shared row, diesel-mapped and the `GET /apps` wire item)
plus a per-kind `…AppConfiguration` (payload only); which configuration a
registration pairs with _is_ its kind, so a row can't claim one kind while
carrying another's payload. See apps' `domain/kind.rs` and the per-kind
`db/<kind>_apps.rs` files.

## The wire: one discriminated union

The storage shape reaches the wire as a **kind-tagged union**: `GET /apps`
returns `AppRegistration[]`, each entry tagged by `kind` alongside the shared
fields, so a client decodes one union and narrows on the tag; the per-kind editor
detail shapes (`CloudAppDetail` etc.) are built `From<(&AppRegistration,
&…Configuration)>` at the route seam.

- **Rust** — an internally-tagged serde enum (or a tagged wire type projected
  from the domain via `From`, which keeps the domain serde-free). Add per-variant
  serde tests when the surface is undocumented (no drift test to catch a slip).
- **TypeScript** — a `Schema.Union` of one `Schema.Struct` per variant, each
  pinning its tag with `Schema.Literal`; consumers narrow with `Extract<T, { kind:
'x' }>` (types) or effect `Match.value` on the tag (rendering).

## Contrast: grants' table-per-kind

When the kinds mostly live apart — every write and keyed lookup names one kind,
and only a couple of reads span them — the shared parent buys little and costs a
cross-table transaction on every write plus a registration-implies-configuration
invariant no schema can enforce. Gatekeeper's grants are that case, so they took
**one table per concrete kind**: `authorization_code_grants` and `device_grants`
each carry ALL their columns (shared and payload alike, every one `NOT NULL` where
it should be), upserts and keyed lookups are single-table statements, and the few
cross-kind reads go through a `grants` SQL VIEW (`UNION ALL` of the tables —
shared columns + a kind tag + each kind's payload column, NULL for the other
kind). Ids are UUIDs minted at insert, so they stay unique across the tables and a
by-id read through the view is unambiguous. The domain is one plain struct per
kind sharing _behaviour_ through a trait (never field-getter bags), with a thin
enum at the wire/list seam keeping the same internally-tagged union. See
`gatekeeper-rust/src/db/grants/` and `src/domain/grant.rs`, and the grants view
migration.

Each side pays a different price. Grants pay shared-column duplication — but it
shows up only in DDL and the view definition, never in a query or invariant. Apps
pay a cross-table write and the implies-configuration invariant — worth it there
because the homescreen queries the shared core as one `ORDER BY position` list, so
the registry IS the feature.

## See also

- [Apps Explanation](./Explanation.md) — the taxonomy this stores.
- [OpenAPI Spec Drift How-To](../Effect/OpenAPI%20Spec%20Drift%20How-To.md) — for a
  union on a _documented_ surface, how the Rust ⇄ TS halves are drift-checked.
- gatekeeper's table-per-kind grants: `gatekeeper-rust/src/db/grants/`,
  `src/domain/grant.rs`.

# Apps Store and Install Explanation

The implementation companion to the [Apps Explanation](./Explanation.md). That
doc explains the app taxonomy and privacy model; this one explains how the
`apps-rust` store persists apps and how the self-hosted upload endpoint installs
them — the invariants the code leans on so the HTTP handlers stay thin.

## Ports and adapters

The slice follows the same ports-and-adapters shape as `collector-rust` and
`tunnel-rust`:

- **`AppsStore` (port)** — a domain trait (`domain/apps_store.rs`) speaking
  _primitive_ persistence over concrete registrations, configurations, and
  `(registration, configuration)` pairs — no "combined app" input, and the only
  union it returns is `AppConfiguration` on `find_app` (where the kind is
  runtime-resolved). The insert/replace methods take a caller-built
  `(registration, configuration)`; for a self-hosted upload the store allocates the
  port and position, and uses the caller's `registration.id` verbatim as id /
  subdomain. Absence and non-permutation are **return-type signals** (`Option`), a
  delete miss is `bool`, and a cloud insert that wrote nothing is the granular typed
  `CloudInsertError`; the only error it raises is the opaque
  `AppsError::Infrastructure`. The self-hosted insert is the exception: with no
  granular signal to distinguish its two non-infra outcomes, it maps them onto
  `AppsError` itself — a taken slug to `400 InvalidName`, an exhausted port space to
  `500`.
- **`SqliteAppsStore` (adapter)** — the `SQLite` implementation
  (`db/apps_store.rs`) over the app-wide diesel pool. It checks a connection out
  of the pool per call and delegates to the `pub(super)` query bodies, which are
  split **by kind/context** (mirroring `domain/actions/`): `db/cloud_apps.rs` /
  `db/self_hosted_apps.rs` / `db/system_apps.rs` each own their `table!`, row
  struct, and mutators; `db/app_registration.rs` owns the shared `app_registrations`
  table + `AppKindColumn` + the registration-wide queries and placement rewrite;
  `db/all_kinds_apps.rs` holds `find_app_on` / `delete` (importing the per-kind
  tables); `db/shared.rs` holds the one `AppUrlColumn` two kinds share. Each is a
  free function taking `&mut PooledDieselConnection` (or `&mut SqliteConnection` for
  the read helpers a mutator calls in-txn).
- **`domain/actions/`** — the slice's _semantics_: it maps the store's
  primitive signals onto the semantic `AppsError` variants (`NotFound`,
  `NotEditable`, `InvalidHomeScreen`, the cloud id-collision verdict; the
  self-hosted create is a thin pass-through since its store maps its own outcomes),
  holds the write-side field validation, and gates the delete removability policy.
  It is a folder split one file per kind (`cloud_apps.rs` / `self_hosted_apps.rs` /
  `system_apps.rs`, the cross-kind `all_kinds_apps.rs`, and the registration-wide
  `app_registration.rs`) so each kind's input struct (e.g. `CloudAppContent`) and
  validation live together. The HTTP handlers build the action's input struct and
  call `actions::…(&state.store, …)`, never the store directly, and stay a straight
  `?`. The actions are unit-tested against an in-memory `FakeAppsStore`
  (`actions/test_fake.rs`) — no db, no HTTP.

Migrations are embedded diesel migrations (`apps-rust/migrations/`) applied once
in `SqliteAppsStore::new` under this slice's **namespace** (`"apps"`) via
`persistence_rust::run_diesel_migrations`, so the apps slice's `0001` and another
diesel slice's `0001` are tracked as distinct `(namespace, version)` rows and
never collide in diesel's stock `__diesel_schema_migrations`. The schema
(`0001_app_registrations`) and the default-registry seed (`0002_seed_default_apps`)
are separate migrations, so the shipped default set versions independently of the
table definitions.

## The store speaks registrations + per-kind payloads

**Class-table-inheritance** persistence over the app-wide diesel pool
(`persistence_rust::DieselPool`): one authoritative `app_registrations` parent (the
global id space, the shared catalogue fields, and the homescreen placement) with
a `kind` discriminator and three symmetric child payload tables (`system_app_configurations`,
`cloud_app_configurations`, `self_hosted_app_configurations`), real FKs child→parent with `ON DELETE
CASCADE`. System apps are ordinary seeded rows now — their launch template lives
in `system_app_configurations.url`, not a compiled-in `SYSTEM_APPS` const.

Reads are **typed diesel queries against real tables** (no `apps_view`, no
`UNION`-with-NULLs decode): the uniform catalogue is a join-free
`app_registrations ORDER BY position` into `AppRegistration`s; a detail read fetches
the registration then the one configuration its `kind` names, returning the
`(registration, configuration)` pair (the configuration as the `AppConfiguration`
union when the kind is runtime-resolved); the host-listener list is a typed inner
join `self_hosted_app_configurations ⋈ app_registrations`. `is_smart` is derived on
the registration (from `client_id`) and `is_removable` via the `CommonAppConfig`
trait, not stored. There is no combined "app" type — the launch/delete seams in the
HTTP layer operate on the `(registration, configuration)` pair directly.

**A corrupt registry surfaces as a typed read error.** A stored `url` that no
longer parses (rejected by the `AppUrl`/`AppKind` column decode), or a
registration whose child payload row is missing (the one CTI invariant SQLite
can't enforce across tables) — each surfaces as a _typed read error_ (a logged
500 at the handler seam), never a partial pair. The single-detail-read decoder
is the enforcement point; handlers don't re-check it per call site.

## Transaction discipline

Three invariants let handlers avoid re-reading and re-validating around the
store:

1. **In-transaction read-back.** Every create / replace re-reads the hydrated
   `(registration, configuration)` pair _inside the same transaction that wrote
   it_ and returns it. So a handler's response is exactly the per-kind detail
   projection with no second read, and cannot drift from stored state.
2. **In-transaction allocation.** Everything the store allocates — the display
   `position` (`MAX(position) + 1`), the loopback port — is computed _inside_ the
   writing transaction, so two overlapping creates can't read the same value and
   collide. `UNIQUE(position)` backstops it regardless. The self-hosted id /
   subdomain are _not_ allocated: they are the caller-built `registration.id` used
   verbatim, and a clash is rejected `400 InvalidName` (checked in the same
   transaction). The
   port-allocation _logic_ is pure and lives in the domain (`lowest_free_port`), fed
   the taken port set the store reads in that same transaction — database-free and
   unit-tested, while the read-then-write stays atomic in the store.
3. **Single writer of order + placement.** `position` and `on_homescreen` are
   written only by `replace_placements` (`PUT /home-screen`); a content replace
   never touches `on_homescreen`. It validates the body is an exact permutation of the live
   registry _in the same transaction_ as the renumber (closing the
   check-then-write race), and moves every row to a disjoint negative range
   before renumbering so the per-row updates never transiently violate
   `UNIQUE(position)` (SQLite's UNIQUE is immediate, not deferrable).

Kind- and seeded-_policy_ gating (which kinds or rows an HTTP surface may edit)
lives in the `domain/actions/` folder — the per-kind `replace_cloud_app` /
`replace_self_hosted_app` resolve the kind first off the `(registration,
configuration)` pair a read hands back, then synthesize the edited pair the store
persists: a wrong-kind (or unknown) id is a **404** (the mismatch can no longer be
expressed as a `409`), a seeded self-hosted app is `409`, before any field is
validated. `delete`'s kind dispatch is split across the handler because
it interleaves filesystem teardown (stop the listener, remove files) around the
store delete. The store's SQL only guards its own invariants (e.g. a cloud content
replace updates `cloud_app_configurations` by id, so a non-cloud id matches no row and is a
no-op).

## The self-hosted upload pipeline

`POST /self-hosted-apps` carries an uploaded zip `bundle` (multipart).
The handler runs a staged install ordered so it never leaves a half-installed
app behind:

1. **Slug** the name to a DNS label (`install::slugify`).
2. **Extract** the zip off the async runtime into a private `.staging/<mint>`
   dir (`install::extract_zip_bundle`) and **infer** the launch path from the
   result.
3. **Move into place** — rename `staging` → `<apps>/<mint>` _before_ the DB
   insert.
4. **Insert** the row (the slug as id / subdomain, allocating the port
   in-transaction); a slug already in use is rejected `400 InvalidName`.
5. **Start** the app's loopback listener.

Any failure removes the staged (or already-moved) directory. Because the files
land at their serving location _before_ the row commits, a committed row always
points at present files; a crash after the move leaks only an unreferenced
folder (no row → never served).

### The content folder is a fresh mint id, not the slug

Each install mints a unique id that names both the staging dir and the final
serving folder (the row's `content_folder`, recorded verbatim). Being unique per
install, the destination can't collide with a folder a failed delete left
behind, and the files can move into place before the row is committed. The slug
is the app's _identity and subdomain_; the content folder is _where its files
live_ — deliberately independent.

### Slug → a valid DNS label, unique or rejected

The slug becomes the app's `id` **and** its public `subdomain`, stored verbatim,
so it is kept a valid DNS label: lowercased, each run of non-alphanumerics
collapsed to a single `-`, trimmed, and capped at **63 chars** (the DNS label
limit) — an over-long label would silently break `<subdomain>.<public_host>`
routing and TLS. The slug is used as-is, **not** suffixed to dodge a collision: a
slug already in the global id space is rejected `400 InvalidName` ("an app with
this name already exists"), which the caller resolves by renaming — the store
raises that directly from its in-transaction id check (there's no granular typed
insert error for self-hosted, unlike cloud's `CloudInsertError`). Every
self-hosted row's subdomain equals its id, so the id
check subsumes the subdomain space; the `UNIQUE(subdomain)` column stays a
backstop.

### Port allocation → lowest free, reused

Each self-hosted app binds its own loopback port (its isolated origin — the
security boundary). The store hands out the **lowest** free port at or above
`MIN_UPLOAD_PORT` (8082, one above the seeded Patient Browser at 8081), skipping
any reserved port (the host's own loopback API port). Reusing freed ports rather
than `MAX(port) + 1` keeps a delete → same-bundle-reinstall cycle on its
original origin — a SMART-on-FHIR origin-stability property. Exhaustion is
`PortSpaceExhausted` — a server resource fault, not a name problem, so it must
not read as a `400`.

### Zip extraction guards two archive hazards

`extract_zip_bundle` unpacks into staging while defending against the two classic
archive hazards:

- **Path traversal ("zip slip").** An entry whose path escapes the root (`..`,
  absolute, or a Windows drive/UNC prefix) is _rejected_, not sanitized — a
  traversal is a hostile bundle, not a fixable one. `enclosed_name` returning
  `None` is the signal.
- **Decompression bombs.** Enforced **twice**: a pre-pass sums the
  header-declared uncompressed sizes and refuses an honestly-huge archive before
  writing a byte; a running budget over the bytes _actually inflated_ aborts
  mid-copy when the headers lied. The declared size is attacker-controlled
  metadata, and the zip reader bounds only the _compressed_ input — so the write
  budget, not the pre-pass, is the real defence. An entry-count cap bounds the
  per-entry loop work independently.

It also normalizes packaging so the served root is the app itself:

- **macOS Finder litter** (`__MACOSX/` resource forks, `.DS_Store`, AppleDouble
  `._*`) is dropped rather than written — otherwise a sibling `__MACOSX/` folder
  masquerades as a second top-level directory and defeats the hoist below.
- **Single-wrapper hoist.** A bundle nested under one top-level directory (the
  common `unzip my-app.zip` → `my-app/…` shape, no top-level files) is flattened
  so `index.html` serves at the origin root.
- **Empty-after-filtering.** An archive that yields no servable file (only litter
  or bare directories) is rejected rather than installed as an app whose every
  request 404s.

A content fault maps to `400 InvalidZip`; only a disk-write failure on our side
is a `500`.

### Launch-path inference

Post-extract, if the (already-hoisted) root ships a `launch.html`, the app
records the SMART launch path
`/launch.html?launch={launch}&iss={origin}/fhir-r4`; otherwise it records
nothing and is served from its bare root (where `/` resolves to `index.html`).
The stored path is one of the same origin-independent templates the cloud `url`
uses — `{origin}` / `{launch}` are substituted per request by
`SelfHostedAppConfiguration::render_launch`, `{origin}` resolving to the served FHIR origin
while the path hangs off the app's own origin. See the [Apps
Explanation](./Explanation.md) for the template model and the
[Origins Explanation](../Origins/Explanation.md) for subdomain dispatch.

## Seeding vendored builds

Seeded self-hosted apps (Patient Browser) are vendored builds synced into
app-data at host startup by `sync_vendored_self_hosted_apps`: dev
overwrite-mirrors the source tree every run, release copies-if-missing from the
bundled resources. Both no-op when the source is absent (fresh clone / CI). The
vendoring model is described in the [self-hosted-apps
README](../../slices/apps/self-hosted-apps/README.md).

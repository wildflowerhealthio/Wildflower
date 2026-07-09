# Apps Store and Install Explanation

The implementation companion to the [Apps Explanation](./Explanation.md). That
doc explains the app taxonomy and privacy model; this one explains how the
`apps-rust` store persists apps and how the self-hosted upload endpoint installs
them — the invariants the code leans on so the HTTP handlers stay thin.

## The store speaks whole apps

One parent `apps` registry row plus a per-kind child table (`cloud_apps`,
`self_hosted_apps`), fronted by a single `AppsStore`. Every read goes through
**one JOIN projection** (`db::reads`) that decodes a whole `App` — the parent row
plus its `AppKind` payload — so the catalogue, a single-row lookup, and the host
listener list can't drift on columns or decoding. `smart` / `removable` are
derived in Rust, not stored as computed columns.

**Parent-implies-child is enforced in one place.** A `cloud` / `self-hosted`
parent whose child row is missing — or whose stored `url` no longer parses —
surfaces as a *typed read error* (a logged 500 at the handler seam), never a
partial `App`. `app_from_row` is the single enforcement point; handlers don't
re-check it per call site.

## Transaction discipline

Three invariants let handlers avoid re-reading and re-validating around the
store:

1. **In-transaction read-back.** Every create / replace re-reads the hydrated
   `App` *inside the same transaction that wrote it* and returns it. So a
   handler's response is exactly the `GET /apps` projection with no second read,
   and cannot drift from stored state.
2. **In-transaction allocation.** Everything the store allocates — the display
   `position` (`MAX(position) + 1`), the self-hosted slug, the loopback port — is
   computed *inside* the writing transaction, so two overlapping creates can't
   read the same value and collide. `UNIQUE(position)` backstops it regardless.
3. **Single writer of order + enabled.** `position` and `enabled` are written
   only by `replace_home_screen` (`PUT /home-screen`); a content replace never
   touches `enabled`. It validates the body is an exact permutation of the live
   registry *in the same transaction* as the renumber (closing the
   check-then-write race), and moves every row to a disjoint negative range
   before renumbering so the per-row updates never transiently violate
   `UNIQUE(position)` (SQLite's UNIQUE is immediate, not deferrable).

Kind- and seeded-*policy* gating (which kinds or rows an HTTP surface may edit)
stays in the handlers, which already hold the whole `App`. The SQL only guards
its own invariants (e.g. a cloud content replace matches `provenance = 'cloud'`,
so a mis-targeted id is a no-op).

## The self-hosted upload pipeline

`POST /apps` with `provenance = self-hosted` carries an uploaded zip `bundle`.
The handler runs a staged install ordered so it never leaves a half-installed
app behind:

1. **Slug** the name to a DNS label (`install::slugify`).
2. **Extract** the zip off the async runtime into a private `.staging/<mint>`
   dir (`install::extract_zip_bundle`) and **infer** the launch path from the
   result.
3. **Move into place** — rename `staging` → `<apps>/<mint>` *before* the DB
   insert.
4. **Insert** the row, allocating the final slug + port in-transaction.
5. **Start** the app's loopback listener.

Any failure removes the staged (or already-moved) directory. Because the files
land at their serving location *before* the row commits, a committed row always
points at present files; a crash after the move leaks only an unreferenced
folder (no row → never served).

### The content folder is a fresh mint id, not the slug

Each install mints a unique id that names both the staging dir and the final
serving folder (the row's `content_folder`, recorded verbatim). Being unique per
install, the destination can't collide with a folder a failed delete left
behind, and the files can move into place before the row is committed. The slug
is the app's *identity and subdomain*; the content folder is *where its files
live* — deliberately independent.

### Slug allocation → a valid DNS label

The slug becomes the app's `id` **and** its public `subdomain`, stored verbatim,
so every candidate is kept a valid DNS label: lowercased, each run of
non-alphanumerics collapsed to a single `-`, trimmed, and capped at **63 chars**
(the DNS label limit). Uniqueness is by suffixing `-2`, `-3`, … against both the
id and subdomain spaces, with the suffix budgeted first so the base is truncated
to fit. An over-long label would silently break `<subdomain>.<public_host>`
routing and TLS. Exhausting the suffix budget is `SlugSpaceExhausted` — a name
problem the caller can retry differently.

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
  absolute, or a Windows drive/UNC prefix) is *rejected*, not sanitized — a
  traversal is a hostile bundle, not a fixable one. `enclosed_name` returning
  `None` is the signal.
- **Decompression bombs.** Enforced **twice**: a pre-pass sums the
  header-declared uncompressed sizes and refuses an honestly-huge archive before
  writing a byte; a running budget over the bytes *actually inflated* aborts
  mid-copy when the headers lied. The declared size is attacker-controlled
  metadata, and the zip reader bounds only the *compressed* input — so the write
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
`SelfHostedApp::render_launch`, `{origin}` resolving to the served FHIR origin
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

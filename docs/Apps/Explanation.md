# Apps Explanation

What an "app" is in Wildflower, how apps are classified, and where a user's
PHI can and can't go when they launch one.

## The problem the taxonomy solves

An app is a thing the user launches from the homescreen. The interesting
question about any app is **where it runs and whether the patient's data can
leave the device when it does**. Two orthogonal axes answer it: **kind** (where
the app is served from) and a set of **capability flags** (what it may do with
PHI). Kind fixes how a launch target resolves; the flags carry the privacy
verdict. The storage layout is **class-table-inheritance**: one authoritative
`app_registrations` parent table (the global id space, the shared catalogue fields,
and the homescreen placement) with a `kind` discriminator and three symmetric
per-kind child payload tables (`system_app_configurations`, `cloud_app_configurations`, `self_hosted_app_configurations`),
real FKs child→parent. A row is its registration plus the one child its `kind`
names. (This replaces the earlier table-per-struct layout, and revises the
class-table-inheritance objection — the registry is a real domain object, not an
abstract base class; see [Polymorphic Rows](./Polymorphic%20Rows%20Explanation.md),
which lays out this shape as one option and contrasts it with gatekeeper grants'.)

## Group A — Kind (one per app, fixed identity)

Kind is **where the app is served from**, which fixes how its launch target is
resolved. It is part of the app's identity; the schema permits a later
cloud↔self-hosted re-point, but there is no switch UI yet.

- **System** — served by the structure of Wildflower itself: a shell route (API
  View, API Docs) or a compiled-in backend. Source-defined only — the user can
  never add, register, or delete one. Always ready to serve. A system app is an
  ordinary seeded `app_registrations` row (`kind = system`) with a `system_app_configurations`
  payload holding its launch template; shipping a change to a system app is a
  migration (the DB is authoritative — there is no longer a compiled-in
  `SYSTEM_APPS` list).
- **Self-Hosted** — web assets served from the device on a **dedicated, isolated
  origin** (a loopback port, or the user's domain via subdomain dispatch). The
  isolated origin is what lets a Self-Hosted app make data-residence guarantees.
  A Self-Hosted app is either **seeded** (a Wildflower-shipped vendored build,
  synced into app-data at host startup — Patient Browser) or **uploaded** (a
  user-supplied `.zip` extracted at runtime by the `wildflower/Apps.c`-gated
  `POST /self-hosted-apps` upload endpoint). Both serve the same way; they
  differ only in origin and removability (see the data model).
- **Cloud** — assets served from a **remote** origin, reaching PHI back through
  the tunnel. Growth Chart, Medication Viewer, and PRECISE-HBR are Cloud.

System vs Self-Hosted is about **origin isolation, not where the bytes shipped
from**: Patient Browser ships inside the download yet is Self-Hosted (it gets its
own isolated origin); API View ships the same way yet is System (it's a shell
route on the main origin).

## Group B — Capabilities (orthogonal flags)

- **SMART App** — **derived** from the app's relation to a registered OAuth
  client: an app is a SMART app **iff it carries a `client_id`** that references
  a row in the gatekeeper `clients` table. This is more direct (and can't drift)
  than inferring SMART-ness from a `{launch}` placeholder in a URL template.
- **Local-Only** — declared **and** enforced no-egress. This pass models the flag
  and shows the badge; **enforcement (CSP `connect-src` / native filtering) is a
  follow-up**, so the badge is a claim about intent, not yet a guarantee.
- **Public / Confidential** — the SMART client type, carried by the linked
  `clients` row. Glossary-only here: documented, not separately badged.

**The privacy verdict comes from the flags, not the kind.** PHI-safe ≈
Local-Only ∧ Public. A Cloud app is not automatically unsafe and a Self-Hosted
app is not automatically safe — the flags decide.

## Data model

**Class-table-inheritance.** One authoritative **`app_registrations`** parent holds
the shared catalogue fields and the homescreen placement for an app of every
kind: `id` (the global id space, an explicit PK), the `kind` discriminator
(`CHECK IN ('system','cloud','self-hosted')`), `position` (UNIQUE, for ordering +
drag-to-reorder), `on_homescreen`, `name`, `subtitle`, `local_only`, the soft
`client_id` reference, and `requires_tunnel` (a launch-readiness signal; false
for system/self-hosted). It is the single writer of ordering + `on_homescreen`
(`PUT /home-screen`).

Each kind's payload lives in a **child table** keyed `id … REFERENCES
app_registrations(id) ON DELETE CASCADE`, so a payload can't exist without its
registration and deleting the registration cascades:

- `cloud_app_configurations` — `url` (the launch URL template).
- `system_app_configurations` — `url` (the `{origin}`-relative launch template; a system app is
  an ordinary seeded row now, not a compiled-in const).
- `self_hosted_app_configurations` — the stable dedicated loopback `port` (UNIQUE), the on-disk
  `content_folder`, the public `subdomain` label (UNIQUE, `<subdomain>.<public_host>`),
  a `seeded` flag, and a nullable `launch_path`. Folder and subdomain are explicit
  columns, not derived from the `id`. `seeded = 1` marks the migration-seeded
  shipped apps (Patient Browser); upload-endpoint rows are `seeded = 0`.
  `launch_path` is the SMART launch path **inferred at install** — set when the
  uploaded bundle ships a `launch.html`
  (`/launch.html?launch={launch}&iss={origin}/fhir-r4`), `NULL` for a root-served
  (`index.html`) app. Like the cloud `url` it's an origin-independent template.

**Reads are typed queries against real tables** (no `apps_view`, no NULLable
union): the uniform catalogue is a join-free `SELECT * FROM app_registrations ORDER BY
position`; a detail read fetches the registration then the one child its `kind`
names. The one CTI invariant SQLite can't enforce across tables — a registration
must have its payload row — is checked at that single detail read as a typed
`Infrastructure` error.

**Removability.** A Cloud app and an **uploaded** (`seeded = 0`) Self-Hosted app
can be deleted — `DELETE /apps/{id}` drops the registration (the child cascades)
and, for self-hosted, stops the listener and removes the on-disk files. A
**seeded** Self-Hosted app and System apps are protected: their delete returns
`409 AppNotEditable`. The per-kind detail shapes surface this as the `isRemovable`
flag (true for cloud and non-seeded self-hosted), which the editor's Remove
button follows.

### The catalogue is a uniform `AppRegistration[]`

`GET /apps` (and `PUT /home-screen`) return a **uniform** `AppRegistration[]` —
one flat shape per app of every kind, no union to narrow: `id`, `kind`,
`onHomescreen`, `name`, `subtitle?`, `localOnly`, `isSmart` (derived from
`client_id`), and `requiresTunnel`. The array order is the display order
(`position` stays on the host). Everything the homescreen tile renders is here; the
per-kind payload (`url`, `launchPath`) is an editor concern, read on a **per-kind
detail** lookup (`GET /cloud-apps/{id}`, `/self-hosted-apps/{id}`,
`/system-apps/{id}`), whose shape is the registration fields plus that kind's
payload (and `isRemovable`).

Detail shapes expose the **stored, origin-independent templates** (the cloud `url`
and the self-hosted `launchPath`, both with `{origin}` / `{launch}` tokens) but
never a **request-resolved** launch URL: the concrete target — with the caller's
origin and a fresh `{launch}` nonce substituted — is materialized only by the
launch endpoint (`GET`/`POST /apps/{id}`), per request, so a forwarded and a
loopback caller each get the right origin.

### Editing app content — per-kind resources

Content edits go through the per-kind resources: `PUT /cloud-apps/{id}` (a JSON
body replacing `name` / `subtitle` / `url` / `requiresTunnel`) and
`PUT /self-hosted-apps/{id}` (replacing `launchPath`; empty clears it back to
root-serving). It is a full **content** replace — `on_homescreen` and display order
stay owned by `PUT /home-screen`. A per-kind path given an id of another kind is a
**404** (the kind mismatch can no longer be expressed as a `409`); a seeded
self-hosted app is `409 AppNotEditable`; system apps have no edit surface. The
response is the refreshed per-kind detail shape. Create is likewise per-kind:
`POST /cloud-apps` (JSON) and `POST /self-hosted-apps` (multipart upload).

### `client_id` is a soft reference

The `app_registrations.client_id` column references `clients.client_id` but is
**not** an enforced SQL foreign key. The `clients` table is owned by the
gatekeeper slice; an enforced cross-slice FK would couple the apps migrations to
gatekeeper's schema and impose a migration ordering across slice boundaries,
violating the slice layering. So the column is a plain reference: the apps slice
derives `isSmart` from its presence alone and never reads the `clients` table. The
invariant — every seeded `client_id` corresponds to a seeded gatekeeper client —
is held by keeping the two SQL seed migrations in lockstep (the seeded cloud
apps' `client_id`s in the apps migration, the gatekeeper sample clients in
gatekeeper migration `008`), each guarded by its own seed test, rather than by
the database.

## Auth posture and the remote trust boundary

The whole `/apps` API is reached through the host's loopback-peer gate, and every
route is behind the **gatekeeper bearer gate** (which inserts the caller's scope
claims). On top of that each route is **scope-gated** through the shared
default-safe capability pattern (`scope-capabilities-rust`; see
[Scope-Gated Endpoints How-To](../Authorization/Scope-Gated%20Endpoints%20How-To.md)),
so an under-scoped caller gets a `403 { error: "InsufficientScope", missingScopes }`:

- `GET /apps` and the admin surface (`/cloud-apps`, `/self-hosted-apps`,
  `/system-apps`, `DELETE /apps/{id}`, `PUT /home-screen`) are gated on
  `wildflower/Apps.{r,c,u,d}` — a read/create/update/delete grant per capability.
- The launch (`GET`/`POST /apps/{id}`) is gated in two layers: a static
  `wildflower/launch` **umbrella** the `Scoped<AppLauncher>` extractor enforces (a
  _known_ scope, granted to the owner explicitly — the `wildflower/*` wildcard does
  not cover it), and — for a **SMART** app (a host-only `client_id`) — a per-app
  check that the caller's grant covers the app's OAuth client's requested scopes.
  A shortfall on the per-app check renders JSON for the loopback/SPA arm and a
  plain-text `403` for a forwarded browser navigation.
- Both the loopback and the forwarded launch ride the same bearer gate. On the web
  the home tile is a native `<a href="/apps/{id}">`, so the launch is a `GET`: a
  plain click navigates the current tab and a cmd/ctrl-click opens a new one —
  affordances a form-`POST`/`fetch` can't preserve. The web auth cookie rides that
  anchor navigation (even the initial document request, before any JS), so the
  forwarded `GET` authenticates. `GET` and `POST` share one handler; a launch is a
  navigation (like an OAuth `authorize`), so a `GET` minting a `{launch}` nonce —
  and bringing the tunnel up for a `requires_tunnel` app — is intentional.

Separately, a Self-Hosted app reachable remotely is served by the host's
**subdomain reverse proxy**: a forwarded `<id>.<public_host>` request is proxied
straight to that app's loopback static listener, **before** the API's auth layer.
Remote reachability of on-device data over those hostnames therefore depends on
**the trusted front authenticating the subdomains** — the proxy itself adds no
gate. This is a deliberate boundary, not an oversight: the front is the gate for
the remote self-hosted surface. (An in-code gate for those origins is possible
future hardening.)

### The forwarded launch plants the app's session cookie

A forwarded launch of a Self-Hosted app redirects the browser to the app's own
subdomain, `https://<id>.<public_host>/`. The web owner session cookie
(`wf_auth`) is **host-only** on `<public_host>`, so it never rides to that
subdomain — the app's origin would carry no session and its own calls back to the
FHIR API (from a different origin) would be unauthenticated. So the launch `302`
carries a `Set-Cookie` that **re-scopes the caller's own session** onto
`<public_host>` (`Domain=`, subdomain-inclusive), planting it on the app's
subdomain once the browser follows the redirect. This only widens the scope of a
token the caller already holds — it mints nothing, and the `Domain` is always the
full tunnel `public_host` (never its registrable parent), so the bearer never
reaches a sibling tenant. The cookie name and attributes stay owned by the
gatekeeper slice; the apps launch handler reaches them through a host-wired seam
(`LaunchCookies`), mirroring how the per-app SMART check reaches the client's
allowed scopes (`AppLaunchScopes`). Loopback and Cloud launches plant nothing here: a loopback self-hosted app
shares the `127.0.0.1` cookie already (and the desktop webview authenticates on
connection provenance), and a Cloud app authenticates through its own OAuth flow.

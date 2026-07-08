# Apps Explanation

What an "app" is in Wildflower, how apps are classified, and where a user's
PHI can and can't go when they launch one.

## The problem the taxonomy solves

An app is a thing the user launches from the homescreen. The interesting
question about any app is **where it runs and whether the patient's data can
leave the device when it does**. Two orthogonal axes answer it: **provenance**
(where the app is served from) and a set of **capability flags** (what it may do
with PHI). Provenance fixes how a launch target resolves; the flags carry the
privacy verdict. The storage layout follows from the taxonomy — a curated parent
registry with one globally-unique `id` per app, plus a per-kind child table —
rather than driving it.

## Group A — Provenance (one per app, fixed identity)

Provenance is **where the app is served from**, which fixes how its launch
target is resolved. It is part of the app's identity; the schema permits a later
cloud↔self-hosted re-point, but there is no switch UI yet.

- **System** — served by the structure of Wildflower itself: a shell route (API
  View, API Docs) or a compiled-in backend. Source-defined only — the user can
  never add, register, or delete one. Always ready to serve. System apps have a
  parent registry row (so they can be reordered/hidden) but **no child config
  row**; their launch URL comes from a compiled-in `SystemApp` source list that
  is the single authority for resolving them.
- **Self-Hosted** — web assets served from the device on a **dedicated, isolated
  origin** (a loopback port, or the user's domain via subdomain dispatch). The
  isolated origin is what lets a Self-Hosted app make data-residence guarantees.
  A Self-Hosted app is either **seeded** (a Wildflower-shipped vendored build,
  synced into app-data at host startup — Patient Browser) or **uploaded** (a
  user-supplied `.zip` extracted at runtime by the owner-gated
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

**The privacy verdict comes from the flags, not the provenance.** PHI-safe ≈
Local-Only ∧ Public. A Cloud app is not automatically unsafe and a Self-Hosted
app is not automatically safe — the flags decide.

## Data model

A **curated parent registry** (`apps`) holds the homescreen list: a globally
unique `id` (so there is no cross-kind collision to resolve), `name`, `subtitle`,
`enabled`, `position` (for ordering + drag-to-reorder), `provenance`,
`local_only`, and the soft `client_id` reference. Per-kind detail lives in child
tables joined by `id`:

- `cloud_apps` — `url` (the **only** place a launch URL is stored) and
  `requires_tunnel`.
- `self_hosted_apps` — the stable dedicated loopback `port`, the on-disk
  `content_folder` the files are served from, the public `subdomain` label
  (`<subdomain>.<public_host>`), a `seeded` flag, and a nullable `launch_path`.
  Folder and subdomain are explicit columns, not derived from the `id`, so an
  app's identity, its served files, and its public hostname are independent.
  `seeded = 1` marks the migration-seeded shipped apps (Patient Browser); rows
  written by the upload endpoint are `seeded = 0`. `launch_path` is the SMART
  launch path **inferred at install** — set when the uploaded bundle ships a
  `launch.html` (`/launch.html?launch={launch}&iss={origin}/fhir-r4`), `NULL`
  for a root-served (`index.html`) app. Like the cloud `url` it's an
  origin-independent template; the launch handler hangs it off the app's own
  origin and substitutes `{origin}` with the served FHIR origin per request.
- System apps have no child row.

**Removability.** A Cloud app and an **uploaded** (`seeded = 0`) Self-Hosted app
can be deleted — `DELETE /apps/{id}` drops the rows (and, for self-hosted, stops
the listener and removes the on-disk files). A **seeded** Self-Hosted app and
System apps are protected: their delete returns `409 AppNotEditable`. The read
shapes surface this as the `removable` flag (true for cloud and non-seeded
self-hosted rows), which the editor's Remove button follows.

### The catalogue is a `provenance`-discriminated union

`AppListEntry` — the shape of `GET /apps` and every create/replace response — is
a **union discriminated on `provenance`**, mirroring the data model: the shared
fields are the `apps` parent row (`id`, `name`, `subtitle`, `enabled`,
`localOnly`, `smart`, `removable`); each variant adds its typed child-table
fields — **cloud** carries `url` + `requiresTunnel`, **self-hosted** carries
`launchPath`, **system** adds nothing. A client narrows on `provenance` to reach
a variant field.

Read shapes expose the **stored, origin-independent templates** (the cloud `url`
and the self-hosted `launchPath`, both with `{origin}` / `{launch}` tokens) but
never a **request-resolved** launch URL: the concrete target — with the caller's
origin and a fresh `{launch}` nonce substituted — is materialized only by the
launch endpoint (`POST /apps/{id}`), per request, so a forwarded and a loopback
caller each get the right origin. Exposing the templates lets the editor display
and edit them without any value on the read shape ever being a live redirect
target.

### Editing app content — `PUT /apps/{id}`

Content edits go through `PUT /apps/{id}`, whose body is the write-side
counterpart union `AppContentBody`, also discriminated on `provenance`: a
**cloud** body replaces `name` / `subtitle` / `url` / `requiresTunnel`; a
**self-hosted** body replaces `launchPath` (empty clears it back to
root-serving). It is a full **content** replace — `enabled` and display order
stay owned by `PUT /home-screen`, the single writer of those. The body's arm
must match the stored app's provenance; a mismatch, a system app, or a seeded
self-hosted app returns `409 AppNotEditable`. The response is the refreshed
`AppListEntry` variant.

### `client_id` is a soft reference

`apps.client_id` references `clients.client_id` but is **not** an enforced SQL
foreign key. The `clients` table is owned by the gatekeeper slice; an enforced
cross-slice FK would couple the apps migrations to gatekeeper's schema and impose
a migration ordering across slice boundaries, violating the slice layering. So
the column is a plain reference: the apps slice derives `smart` from its presence
alone and never reads the `clients` table. The invariant — every seeded
`client_id` corresponds to a seeded gatekeeper client — is held by keeping the
two SQL seed migrations in lockstep (the apps registry's `client_id`s in apps
migration `004`, the gatekeeper sample clients in gatekeeper migration `008`),
each guarded by its own seed test, rather than by the database.

## Auth posture and the remote trust boundary

The whole `/apps` API is reached through the host's loopback-peer gate. On top of
that:

- `GET /apps` is **owner-gated** (a bearer the SPA already carries).
- The **loopback** launch (`POST /apps/{id}` from the on-device webview) is
  owner-gated.
- The **forwarded** launch (a remote browser through the tunnel) stays on the
  network gate / front trust boundary — owner-gating it would require a bearer
  whose audience matches the public origin, which is out of scope this pass.

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
(`LaunchCookies`), mirroring how the loopback owner gate reaches the owner-bearer
check. Loopback and Cloud launches plant nothing here: a loopback self-hosted app
shares the `127.0.0.1` cookie already (and the desktop webview authenticates on
connection provenance), and a Cloud app authenticates through its own OAuth flow.

# Apps Explanation

What an "app" is in Wildflower, how its launch target is resolved, and where a
user's PHI can and can't go when they launch one.

## What an app is

An app is a thing the user launches from the homescreen: a registry row naming a
web page and the template that launches it. Two facts about an app decide how
it reaches the patient's data: whether it is a [SMART app](#smart-apps), which
earns its own bearer for the API, and its `requires_tunnel` flag, which fixes how
a launch reaches the device's FHIR server.

An app's assets are served from its own origin, never the host's. Growth Chart,
Medication Viewer, and PRECISE-HBR are third-party apps. The **first-party** apps —
Medications (`medications-app`), Web Trace (`web-trace-app`), the Server Docs
console (`web-server-docs`), Importer (`importer-app`), the OHIF imaging viewer
(`ohif-viewer`) and Lifting (`lifting-app`) — are published to
<https://wildflowerhealth.io> by `apps/github-pages` and launched from there.
Serving the deployed copy means a shipped app updates when the site deploys
rather than when the user installs a new desktop build.

An app reaches PHI through `{origin}` in its stored launch template, and
`requires_tunnel` decides which origin that is: set, it forces the tunnel up and
substitutes the tunnel's verified HTTPS origin, so a launch fails `503` when the
tunnel can't come up; clear, it substitutes the **served** origin — loopback for
an on-device launch, the forwarded public origin for a remote one. Every seeded
row sets it, the first-party ones included: their pages are HTTPS documents on
<https://wildflowerhealth.io>, and an `iss={origin}` fetch from there to a
loopback origin is unreachable remotely and refused by WebKit even on device.
Only the debug-only `<id>-dev` rows below clear it, since their pages are served
from `localhost` themselves. The trade-off: with the assets remote and the
tunnel required, a first-party launch needs the network even on-device.

The SMART apps this repository publishes (every app that mounts
`smart-app-react`'s `SmartAppRoot`) send nothing from the browser but their FHIR
traffic until the visitor answers a telemetry consent dialog, which comes before
anything else on the page. Only after a yes do they report to Sentry, each to
its own project: crash reports, which can carry data the app loaded, and
anonymized performance data, each behind its own switch. See the
[Telemetry Explanation](../../slices/telemetry/docs/Telemetry%20Explanation.md).

### Dev rows

In **debug builds only** each first-party app additionally gets an `<id>-dev`
row bound to that app's vite dev-server port (pinned once in
`slices/apps/dev-app-ports.json`, which the Rust seed embeds and the vite
configs read through the shared `devAppServer` helper in the root
`vite.config.base.ts`), so a developer's local build is what the tile launches.
Those rows are a runtime seed (`apps-rust/src/dev_seed.rs`), never a migration —
migrations run unconditionally, so a migration-seeded dev row would exist in
release databases too.

A dev tile launches whatever is serving the port — the vite (or preview) server
when it is up, nothing when it is down. Each SMART dev row has its own OAuth
client (gatekeeper's `seed_dev_app_clients`) whose id equals the dev app id and
whose redirect URI, `http://localhost:{port}` plus the app's callback path, is
what `/authorize` matches.

## SMART apps

An app is a **SMART app** iff it carries a `client_id` that references a row in
the gatekeeper `clients` table. SMART-ness is derived from that relation to a
registered OAuth client, which is more direct (and can't drift) than inferring it
from a `{launch}` placeholder in a URL template. The SMART client type —
**public** or **confidential** — is carried by the linked `clients` row; it is
documented here, not separately badged.

## Data model

One **`app_registrations`** table holds the whole app: `id` (the global id
space, an explicit PK), `position` (UNIQUE, for ordering + drag-to-reorder),
`on_homescreen`, `name`, `subtitle`, `url` (the launch template), the soft
`client_id` reference, and `requires_tunnel` (a launch-readiness signal).
`PUT /home-screen` is the single writer of ordering + `on_homescreen`.

The `url` is an origin-independent template (`domain/app_url.rs`): an absolute
`http(s)://` URL or an origin-relative path, either of which may embed `{origin}`
and `{launch}` tokens. Anything else — `javascript:`, `data:`, a
protocol-relative `//authority`, an `{origin}` followed by anything but a
path/query/fragment boundary — is rejected on write, and a stored value that no
longer parses fails the read as a typed error.

Every app can be deleted: `DELETE /apps/{id}` drops its row. A user-deleted seed
stays deleted across upgrades, because each seed migration runs once per
database.

### The registration is the wire shape

`GET /apps` (and `PUT /home-screen`) return `AppRegistration[]` — one flat shape
per app: `id`, `onHomescreen`, `name`, `subtitle?`, `url`, `isSmart` (derived
from `client_id`), and `requiresTunnel`. The array order is the display
order (`position` stays on the host). `GET /apps/{id}` returns the same shape for
one app.

The `url` on the wire is the **stored template**, never a **request-resolved**
launch URL: the concrete target — with the caller's origin and a fresh `{launch}`
nonce substituted — is materialized only by the launch endpoint
(`POST /apps/{id}`), per request, so a forwarded and a loopback caller each get
the right origin.

### Creating and editing

`POST /apps` creates an app and `PUT /apps/{id}` replaces its content, both from
the same JSON body (`name`, `subtitle`, `url`, `requiresTunnel`). The server mints
a created app's id; the app lands at the end of the homescreen, with no
`client_id`. A replace is a full **content** replace —
`on_homescreen` and display order stay owned by `PUT /home-screen` — and an
unknown id is a `404`. Both answer with the stored registration.

### `client_id` is a soft reference

The `app_registrations.client_id` column references `clients.client_id` but is
**not** an enforced SQL foreign key. The `clients` table is owned by the
gatekeeper slice; an enforced cross-slice FK would couple the apps migrations to
gatekeeper's schema and impose a migration ordering across slice boundaries,
violating the slice layering. So the column is a plain reference: the apps slice
derives `isSmart` from its presence alone and never reads the `clients` table. The
invariant — every seeded `client_id` corresponds to a seeded gatekeeper client —
is held by keeping the two slices' seeds in lockstep (the seeded apps'
`client_id`s in the apps migrations, the matching clients in the gatekeeper
ones), each guarded by its own seed test, rather than by the database.

A client's redirect URIs are absolute URLs, matched by exact equality at
`/authorize`. Each first-party client registers its published callback page —
the app root `https://wildflowerhealth.io/<app>/` for most apps,
`https://wildflowerhealth.io/ohif-viewer/fhir-viewer` for OHIF; its `<app>-dev`
sibling registers `http://localhost:{port}` plus the same path.

## Auth posture and the remote trust boundary

The whole `/apps` API is reached through the host's loopback-peer gate, and every
route is behind the **gatekeeper bearer gate** (which inserts the caller's scope
claims). On top of that each route is **scope-gated** through the shared
default-safe capability pattern (`scope-capabilities-rust`; see
[Scope-Gated Endpoints How-To](../Authorization/Scope-Gated%20Endpoints%20How-To.md)),
so an under-scoped caller gets a `403 { error: "InsufficientScope", missingScopes }`:

- `GET /apps`, `GET /apps/{id}`, `POST /apps`, `PUT /apps/{id}`,
  `DELETE /apps/{id}` and `PUT /home-screen` are gated on
  `wildflower/Apps.{r,c,u,d}` — a read/create/update/delete grant per capability.
- The launch (`POST /apps/{id}`) is gated in two layers: a static
  `wildflower/launch` **umbrella** the `Scoped<AppLauncher>` extractor enforces (a
  _known_ scope, granted to the owner explicitly — the `wildflower/*` wildcard does
  not cover it), and — for a **SMART** app (a host-only `client_id`) — a per-app
  check that the caller's grant covers the app's OAuth client's requested
  **resource** scopes (its FHIR / Wildflower data access; the OIDC and SMART
  launch-context scopes are the app's own OAuth concern, so the owner isn't required
  to hold them). A shortfall on the per-app check returns the shared
  `InsufficientScope` JSON body, which the owner UI's typed client decodes into
  the home banner — keeping the missing scopes structured so the banner names them
  (and a future "request permissions" action can read them).
- Both the loopback and the forwarded launch ride the same bearer gate: every
  owner UI launches through the typed client with its bearer. A loopback launch
  `204`s after the host opens the app in a native popup. A forwarded launch (the
  hosted owner UI reaching the server through its tunnel) answers `200 { url }`,
  and the page navigates the tab there — a redirect would be followed invisibly by
  `fetch` rather than moving the tab. A home tile is a real link to the owner
  UI's launch route (`/home/launch/{id}`): a plain click launches in place, and
  a ctrl/cmd/shift or middle click opens the new tab inside the click (so no
  popup blocker stops it) and launches into it on this page's session. A tab
  the browser opens by itself from the link has no session. The signed-in
  owner UI's URLs don't name a server, so that tab lands on the server picker.

### No launch sets a cookie

The server authenticates by `Authorization: Bearer` alone, so no launch plants
a session for the app it opens. A SMART app earns its own bearer through its
OAuth flow. A non-SMART app has no credential of its own, so only a SMART app
reaches the API.

## See also

- [Apps Store Explanation](./Store%20Explanation.md) — how `apps-rust` persists
  the registry and the invariants its writes hold.
- [Origins Explanation](../Origins/Explanation.md) — the served origin `{origin}`
  resolves to.

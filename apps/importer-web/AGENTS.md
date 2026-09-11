# AGENTS.md — apps/importer-web

The Importer, shipped as a **cloud** SMART-on-FHIR app served from the published
GitHub Pages site (`/importer-app`), with a debug-only self-hosted dev row for
local development. It pairs
[`importer-react`](../../slices/importer/importer-react/AGENTS.md)'s
`ImporterScreen` with
[`anonymizer-react`](../../slices/anonymizer/anonymizer-react/AGENTS.md)'s
`AnonymizerScreen` under an **Import | Anonymize** header toggle
(`react-tundraish`'s `SegmentedToggle`) — the app itself holds no importing or
anonymizing logic, only the tabstrip, the wiring a SMART app needs, and the
one adapter the anonymizer's `serverSource` slot asks of a host (it passes
`importer-react`'s `ServerHarArchiveList` through — both slices' `PickedFile`
carry `{ fileName, bytes }`, so the adapter is the identity). The unselected
screen is unmounted, not hidden.

`apps/web-trace` is the template for this shape (two HTML entries, a relative
`base`, a build straight into the vendored `self-hosted-apps` tree, a memory
router carrying a SMART-built context, and a standalone `ConnectMenu` beside the
EHR launch). **One thing is deliberately different: this app writes.** Everything
that follows from that is called out below.

The npm package is `wildflower-importer` (the web-trace naming convention — its
package is `wildflower-web-trace` while its app id is `web-trace-app`). The app
id and the OAuth `client_id` are both `importer-app` — the published path
segment, matching `medications-app` / `web-trace-app`. The vendored build folder
is `importer`, and the debug-only dev row is `importer-app-dev`. Those identities
are load-bearing — see [Seeded registration](#seeded-registration).

## Why this app has a router and a bearer token

The wiring itself is **not this app's** — it lives in
[`fhir-r4-react/smart`](../../slices/emr/fhir-r4-react/src/smart/self-hosted-runtime.ts),
because every SMART app served from its own origin needs the same thing. `app.tsx`
imports `buildSmartRouterContext` from there directly — there is no local
re-export to edit, deliberately, so a change to the behaviour has to be made in
the one place that owns it. The guardrail listing the properties that must
survive is in [slices/emr/AGENTS.md](../../slices/emr/AGENTS.md).

Two facts about an app served off its own origin drive everything in that
runtime:

- **It is served from a different origin than the API** — the published Pages
  site (`https://wildflowerhealth.io/importer-app/`) in production, or the
  loopback dev origin (`http://127.0.0.1:5193/`) under the debug-only
  `importer-app-dev` row. The typed FHIR client emits _relative_ paths
  (`/fhir-r4/DocumentReference`), which would resolve against the app's own
  origin and 404. So the layer prefixes them with the FHIR base the SMART
  handshake named.
- **The API's `wf_auth` cookie is not sent cross-origin.** So this app
  authenticates the way any SMART app does — with the token it was granted,
  attached as a bearer header.

`importer-react` reads its authed runner out of **route context**
(`fhir-r4-react`'s `useRunAuthed`), which is how every consumer of that package's
queries gets one. So this app builds a router and supplies the same
`RouterContextWith<FhirR4ResourcesHttpApiClient>` shape, rather than the slice
package growing a second, prop-threaded way in.

## EHR launch and standalone launch

The app is reachable two ways, both wired here:

- **EHR launch** — the homescreen tile (the `importer-app` cloud row) opens
  `launch.html`, which starts the SMART authorize redirect against the FHIR base
  the host names (`iss={origin}/fhir-r4`). `index.html` is the redirect target.
- **Standalone launch** — a visitor lands on the published `index.html` directly.
  With no OAuth callback in the URL, `app-root.tsx`'s `AppRoot` renders
  `SiteHeader` + `ConnectMenu` (`fhir-r4-react/connect`) + `SiteFooter` in shared
  Wildflower chrome, where the user picks the FHIR server to import into.
  `shouldCompleteSmartLaunch()` is the gate between the two; the EHR-launched
  branch renders `BrandBar` + `App` instead.

Both run through the one registered client (`importer-app`, or `importer-app-dev`
in a vite dev build), whose redirect URI is the app root — so the same handshake
completion path serves both.

## Scopes: this app writes, and the two sides must match exactly

`src/config.ts` requests (in both `smartConfig` and `standaloneSmartConfig`):

```text
launch openid fhirUser system/DocumentReference.rs
system/DocumentReference.u system/Patient.u system/Observation.u
```

SMART v2 letter granularity, tightened to the interactions the flow issues (not
the mechanical v1 `.read`/`.write` expansion): `DocumentReference.rs` = read +
search (it searches for existing archives and reads one back by id); `.u` =
update on each written type (every write is a `PUT /{type}/{uuid}`
update-as-create — no `POST` create `.c`, no `DELETE` `.d`).

- **Why writes at all.** Importing means persisting what a captured session
  contained. The write set is exactly what the flow produces today: the archive
  `DocumentReference` the confirm step uploads, plus the `Patient` and
  `Observation` resources the registered `fhir-r4` source extracts out of a
  capture. Widen it alongside a new collector or entity, never ahead of one.
- **Why `system/` and not `patient/`.** A HAR archive carries no `subject` — it
  records a browsing session, not a clinical fact about a person — so it is
  unreachable through patient context and a `patient/` scope would match
  nothing.
- **The pin.** This string MUST equal the `allowed_scopes` JSON array in
  `gatekeeper-rust`'s `0008_seed_wildflower_importer_client` migration, element
  for element: a scope the app requests but the client is not allowed fails the
  authorize step. **There is no cross-language test that checks this** — the
  repo's derive-both-sides pattern needs one source, and a SQL seed and a TS
  constant have none in common. So the pairing is held by three mirrors instead:
  the doc comment in `src/config.ts`, the migration's own comment, and the exact
  seven-element vector asserted in `gatekeeper-rust`'s `db/clients.rs`. Change
  one, change all four. A **dev** build authorizes against the sibling
  `importer-app-dev` client instead (`gatekeeper-rust`'s `seed_dev_app_clients`,
  see [Seeded registration](#seeded-registration) below), which carries the same
  set — widen it in step too, or `/authorize` fails only in a vite dev build. Do
  **not** invent a parity test that hand-copies the list a third time — that is
  the self-referential drift guard [Review
  Standards](../../docs/Agents/Review%20Standards%20Reference.md) names.

## Traps

- **The history is a memory history.** This page is the OAuth redirect target,
  so its real URL carries `?code=…&state=…`. A browser history would try to
  match that against the route tree, and any navigation would rewrite the URL
  the SMART handshake is still reading.
- **Plain `FetchHttpClient.layer`, not `telemetry-react`'s
  `webHttpClientLayer`.** Not for a `local_only` reason — this app is registered
  `local_only = 0`, because its assets are served from wildflowerhealth.io and it
  writes to the FHIR base the handshake named. The reason is that the importer
  talks to exactly one host, the one the handshake named, and adding an OTLP
  destination would put a second, uninstrumented one into a bundle whose whole
  job is moving the user's records between two places they chose. `app.tsx` is
  the only file that names the real transport; `buildSmartRouterContext` keeps it
  a parameter so `app.test.tsx` can drive a stub.
- **`build` is `vp build`, with no `tsc` step.** The tsconfig sets
  `customConditions: ["source"]` so `tsc` and the bundler agree on which copy of
  `QueryClient` a slice's router context refers to. But under that condition a
  package-local `tsc` also re-typechecks _other_ workspace packages' sources
  under this app's compiler options (e.g. `erasableSyntaxOnly` rejects syntax in
  `kitchen-sink`), which fails on code this app does not own. Typechecking comes
  from `vp check`, which is CI's gate and resolves the same way the bundler does.
- **The app owns no importing or anonymizing surface.** `ImporterScreen` takes
  no props; `AnonymizerScreen` takes only the `serverSource` slot. Each owns
  every level below it (source pick → preview → confirm/download → results).
  This app renders a heading, the Import | Anonymize tabstrip, and the one
  screen the picked tab mounts. Splitting a flow across that boundary is the mistake `apps/web-trace`
  made with its exchange detail and had to undo: both surfaces opened at once
  and the accessibility tree hid it. Re-creating any of the four levels here
  re-creates that.
- **The tabstrip state lives inside `ImporterHome`, not `ImporterApp`.** The
  router memo above is keyed on the context; lifting `tab` into `ImporterApp`
  would rebuild the router (and its mounted tree) on every tab switch. Keep the
  `useState<Tab>` a per-render local of `ImporterHome`.
- **The unselected tab is unmounted.** The two screens hold their own state
  (`AnonymizerScreen`'s pick, `ImporterScreen`'s read/confirm), and toggling
  the header is a fresh mount, not a `display: none` swap — the accessibility
  tree only carries the surface the user is on, and a flip-back opens fresh at
  the picker. Do not lift screen state into the app to preserve it across
  toggles.
- **The app test must run through the real `buildSmartRouterContext`.** The
  slice's `importer-screen.test.tsx` mocks the `useRunAuthed` seam, so nothing
  down there ever puts a prefixed URL or an `Authorization` header on the wire.
  This app's test is the only place that does — keep it that way rather than
  stubbing the context here too.
- **jsdom's `TextEncoder` returns a foreign-realm `Uint8Array`** that the archive
  codec's `Uint8ArrayFromSelf` schema rejects on `instanceof`. Any test that
  drives the confirm step's local upload needs the `RealmSafeTextEncoder`
  `vi.stubGlobal` workaround (copied from `importer-screen.test.tsx`); it is a
  jsdom artifact, not a bug in the codec.
- **`vp test` for this package needs the workspace-local binary**
  (`node_modules/.bin/vp`) — the global `vp`'s bundled vitest cannot resolve
  jsdom.

## Seeded registration

The app is registered as a **cloud** row served from the published site, by two
migrations that must land together — an app registration whose `client_id` has no
registered client cannot launch:

- `slices/apps/apps-rust/migrations/0006_seed_wildflower_importer_app/` — the
  `importer-app` cloud registration + its `cloud_app_configurations` launch URL
  (`https://wildflowerhealth.io/importer-app/launch.html?launch={launch}&iss={origin}/fhir-r4`),
  `local_only = 0`, `requires_tunnel = 1` (like `medications-app` / `web-trace-app`).
- `slices/gatekeeper/gatekeeper-rust/migrations/0008_seed_wildflower_importer_client/`
  — the `importer-app` OAuth client, with the app-relative `"/"` redirect (for
  the dev row) plus the absolute `https://wildflowerhealth.io/importer-app/`
  redirect it launches from as a cloud app.

The `clientId` in `src/config.ts` must equal the app id in both. `local_only` is
**0**, like the other two cloud apps.

A **debug build** additionally seeds a self-hosted `importer-app-dev` row
(`apps-rust`'s `dev_seed.rs`) bound to this app's vite dev-server port
(`slices/apps/dev-app-ports.json` → `5193`), plus its sibling OAuth client
(`gatekeeper-rust`'s `seed_dev_app_clients`) carrying the same write scopes. That
row is what a developer running `vp run -F wildflower-importer dev` launches; its
`content_folder` is the vendored `importer` build, which serves as fallback when
vite is not holding the port.

## Published on GitHub Pages

`apps/github-pages` stages this app's build at `/importer-app` on
<https://wildflowerhealth.io>, alongside the medications and web-trace apps. The
relative `base: './'` in `vite.config.ts` is the whole subpath mechanism. No SPA
fallback is needed: the router is a memory history, so the site has no deep links
into it. The marketing site links there from its "collection of apps" section
(`apps/marketing-website/src/data/convergence.ts`).

## Boot and chrome

`main.tsx` imports stylesheets (tundra → tundraish → branding → fonts), calls
`addOsColorSchemeListener()`, and renders `<AppRoot />`. `AppRoot` (exported from
`app-root.tsx` and from the package's `"."` export as a `source`-only seam) owns
the `QueryClientProvider` and the chrome gate:

- **launched** (`shouldCompleteSmartLaunch()` or the prop) → `<BrandBar />` +
  `<App />`.
- **not launched** → `<SiteHeader nav={fromApp} />` + `<main>` (the same `.app`
  shell class `App` uses, so the menu is centred and padded under the chrome)
  wrapping `<ConnectMenu …/>` + `<SiteFooter nav={fromApp} />`.

The decision is **latched on mount** (`useState` initializer), not derived per
render: fhirclient's `oauth2.ready()` strips `code`/`state` from the URL once the
exchange completes, so a re-render that re-read the URL would flip a completed
launch back to the connect menu. `ConnectMenu`'s `redirectUri` is derived from
`window.location` inside render rather than at module load, so this module reads
`window` only once a tree is mounting, never as a side effect of being imported.

The `source`-only export (`"exports": { ".": { "source": "…" } }`) has no
`default` condition — no lib build ships. A future aggregator shell resolves the
workspace `source` condition at bundle time.

## Testing

- The auth wiring in isolation — prefix derivation, the relative/absolute split,
  and that an absent token sets no header — is
  [`fhir-r4-react`'s `self-hosted-runtime.test.ts`](../../slices/emr/fhir-r4-react/src/smart/self-hosted-runtime.test.ts).
- The import flow's own semantics — zero writes to reach a preview, `meta.source`
  on every written resource, partial results, cancel — are
  [`importer-react`'s `importer-screen.test.tsx`](../../slices/importer/importer-react/src/importer-screen.test.tsx).
- `app-root.test.tsx` — chrome-level tests: `launched: true` renders `BrandBar`
  (the link with `aria-label="Wildflower, home"` pointing to
  `https://wildflowerhealth.io/`); `launched: false` renders `SiteHeader`,
  `ConnectMenu` inside the `main` landmark, and `SiteFooter` with absolute nav
  hrefs. With no prop, a table of `location.search` values pins which branch
  mounts, and one case strips the callback params after mount to pin that the
  decision is latched. The `ConnectMenu` stub echoes its props, so the
  `clientId` / `scope` / `redirectUri` wiring is asserted too. `./app.tsx` and
  `fhir-r4-react/connect` are stubbed — this file tests the chrome gate, not the
  SMART handshake or the router.
- `app.test.tsx` — the whole tree over a recording stub transport, through the
  real `buildSmartRouterContext`. It walks a synthesized HAR (built with
  `web-trace-core`'s `emitHar` + `test-helpers`, the established pattern —
  don't reach into `har-importer-core`'s fixture) from pick to review to confirm,
  and asserts what only this layer can see: every read **and every write** is
  addressed to the FHIR base and carries `Bearer …`, and the resource types
  written are exactly the ones `config.ts`'s scope string covers. Also pins the
  tabstrip: the Import tab is the default, flipping to Anonymize unmounts the
  Import surface (and the subtitle switches), and the Anonymize tab reaches a
  download from a picked HAR with **zero writes** on the wire.

## References

- [emr slice AGENTS.md](../../slices/emr/AGENTS.md) — the shared SMART runtime
  this app imports (`fhir-r4-react/smart`), and the auth-critical properties it
  must keep.
- [importer-react AGENTS.md](../../slices/importer/importer-react/AGENTS.md) —
  the screen this app mounts, and its traps.
- [importer slice AGENTS.md](../../slices/importer/AGENTS.md) — the
  preview-then-confirm opt-in seam.
- [apps/web-trace AGENTS.md](../web-trace/AGENTS.md) — the read-only twin this
  app is cloned from.
- [Store and Install Explanation](../../docs/Apps/Store%20and%20Install%20Explanation.md)
  — how a first-party app is registered as a cloud row and served, and how the
  debug-only `-dev` self-hosted rows work.
- [self-hosted-apps README](../../slices/apps/self-hosted-apps/README.md) — the
  vendored-build sync this app's `outDir` feeds.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.

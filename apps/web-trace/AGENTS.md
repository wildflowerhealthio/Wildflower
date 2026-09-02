# AGENTS.md — apps/web-trace

The Web Trace viewer, a SMART-on-FHIR app published to
<https://wildflowerhealth.io/web-trace-app> and launched as a cloud app (with a
self-hosted `web-trace-app-dev` row in debug builds — see below). It wraps
[`web-trace-react`](../../slices/web-trace/web-trace-react/AGENTS.md) — the app
itself holds no viewing logic, only the wiring a self-hosted origin needs.

`apps/medications-app` is the template for the bundle shape (two HTML entries,
a relative `base`, a build straight into the vendored `self-hosted-apps` tree).
What is _not_ shared with it is the auth wiring below.

## Boot and branding

`main.tsx` loads design-system stylesheets (tundra-css → react-tundraish →
branding-react), installs the OS colour-scheme listener, and renders `<AppRoot />`
from `app-root.tsx`. `AppRoot` is the page-level seam: it picks between the
launched viewer (slim `BrandBar` + `App`) and the standalone connect page (full
`SiteHeader` + `ConnectMenu` + `SiteFooter`), with a single `QueryClientProvider`
wrapping both branches. The `launched` prop is read once, on mount: it defaults
to `shouldCompleteSmartLaunch()` but accepts an explicit boolean so each branch
is testable without URL games, and it is latched because fhirclient strips
`code`/`state` from the URL once the exchange completes. The package exports
`AppRoot` via a source-only `exports` map (`"source": "./src/app-root.tsx"`) with no `default` — a future
aggregator shell resolves the workspace `source` condition.

## Why this app has a router and a bearer token

The wiring itself is **not this app's** — it lives in
[`fhir-r4-react/smart`](../../slices/emr/fhir-r4-react/src/smart/self-hosted-runtime.ts),
because every self-hosted SMART app needs the same thing and this app was only
the first. `app.tsx` imports `buildSmartRouterContext` from there directly —
there is no local re-export to edit, deliberately, so a change to the behaviour
has to be made in the one place that owns it. The guardrail listing the three
properties that must survive is in
[slices/emr/AGENTS.md](../../slices/emr/AGENTS.md).

Two facts about a self-hosted app drive everything in that runtime:

- **It is served from its own origin** — the published site in production, the
  vite dev server's loopback port in dev — never the API's. The typed FHIR client
  emits _relative_ paths (`/fhir-r4/DocumentReference`), which would resolve
  against that origin and 404. So the layer prefixes them with the FHIR base the
  SMART handshake named.
- **The API's `wf_auth` cookie is not sent cross-origin.** That cookie is what
  authenticates the host's own webview; a third-party origin gets none of it. So
  this app authenticates the way any SMART app does — with the token it was
  granted, attached as a bearer header.

`web-trace-react` reads its authed runner out of **route context**
(`fhir-r4-react`'s `useRunAuthed`), which is how every consumer of that package's
queries gets one. So this app builds a router and supplies the same
`RouterContextWith<FhirR4ResourcesHttpApiClient>` shape, rather than the slice
package growing a second, prop-threaded way in.

## Traps

- **Three of the traps that used to be listed here are the shared runtime's
  now** — the typed client emits base-relative FHIR paths and the provider names
  the base (here: `client.state.serverUrl` prepended verbatim, no `iss` parsing
  and no `Left`), the bearer token that rides only the requests the layer
  addressed, and the transport staying a parameter. They are enforced in
  `fhir-r4-react/smart`; the guardrail that spells all three out is in
  [slices/emr/AGENTS.md](../../slices/emr/AGENTS.md). What is still this app's is
  that `app.tsx` names the real transport, and `app.test.tsx` pins what goes on
  the wire end to end.
- **The history is a memory history.** This page is the OAuth redirect target,
  so its real URL carries `?code=…&state=…`. A browser history would try to
  match that against the route tree, and any navigation would rewrite the URL
  the SMART handshake is still reading.
- **Plain `FetchHttpClient.layer`, not `telemetry-react`'s
  `webHttpClientLayer`.** The app's `local_only` badge is off since the move to
  the published site (its assets are remote now), but the property the badge
  described — this app makes no outbound request of its own — is still worth
  keeping, and the telemetry layer's OTLP exporter is exactly the kind of
  outbound request it rules out.
- **`build` is `vp build`, with no `tsc` step** (unlike `apps/medications-app`).
  The tsconfig sets `customConditions: ["source"]` so `tsc` and the bundler agree on
  which copy of `QueryClient` a slice's router context refers to — without it,
  threading that context into `QueryClientProvider` does not typecheck against
  the rolled-up `dist/*.d.ts`. But under that condition a package-local `tsc`
  also re-typechecks _other_ workspace packages' sources under this app's
  compiler options, which fails on code this app does not own. Typechecking
  comes from `vp check`, which is CI's gate and resolves the same way the bundler
  does.
- **The scope set is read-only, deliberately.** This is the app that reads the
  rawest data on the device; never writing is worth preserving as a property of
  it. `system/` rather than `patient/` because trace `DocumentReference`s carry
  no `subject` and are not reachable through patient context.
- **The viewer does not redact; the export flow does, and it lives in the
  slice.** Capture is lossless and this runs on the user's own device against
  their own data. Redaction belongs to the export boundary, and the button that
  reaches it is `RecordingsPanel`'s — this app adds no export surface, so the
  no-outbound-requests property has no code here to violate it.
- **The slice's panels own every level, including the exchange detail.** This app
  renders no viewing surface of its own and holds no selection state within a
  panel. It briefly did: the panel used to leave the detail to its host, and
  this app carried `exchange-detail.tsx`, `body-text.ts`, and `headers.ts` to
  satisfy that. When the panel grew its own third level, **both** surfaces
  opened on one click. The app's `hidden` wrapper dropped the panel out of the
  accessibility tree, so every query but one saw a single detail; "Back to
  exchanges" then resolved to the app's control, closed the app's copy, and
  revealed the panel still holding the detail the reader had just dismissed.
  Re-adding a detail surface here re-creates that. The slice's
  `viewable-attachment.ts` carries the `fatal: true` body decode that
  `body-text.ts` used to, and `ExchangeDetail` keys repeated header rows by
  position, which is what `headers.ts` was for.
- **The tabstrip is the one piece of navigation this app does own, and the line
  is composition vs. viewing.** `ViewerScreen` chooses between `RecordingsPanel`
  and `DocumentsPanel`; each panel still owns every master/detail level inside
  it — recordings goes sessions → exchanges → one exchange → export, documents
  goes documents → one document. Selecting which slice component to mount is
  composition; rendering any level below a tab would be viewing logic and
  belongs in the slice.
- **The unselected panel is unmounted, never hidden.** A `hidden` wrapper is
  exactly what made the last collision invisible to every accessibility query
  but one. An unmounted panel cannot answer a query at all, so a duplicated
  control surfaces as a test failure rather than as a silent overlap —
  `app.test.tsx` asserts the absence directly.

## Where the bundle is served

Two places, from the same build output:

- **On the published site**, at
  [`/web-trace-app`](https://wildflowerhealth.io/web-trace-app) — `github-pages`
  copies the `outDir` into the Pages artifact
  ([apps/github-pages/README.md](../github-pages/README.md)). This is the
  **production** launch target: the `web-trace-app` registry row is a _cloud_ row
  pointing at that URL.
- **On device**, from the vendored `self-hosted-apps/web-trace` tree this app's
  `outDir` writes — as the debug-only `web-trace-app-dev` row's fallback content
  when the vite dev server is not running (see below).

## Registration

The `web-trace-app` app row (a cloud row) and its OAuth client are seeded by
migrations that must stay in lockstep — an app registration whose `client_id` has
no registered client cannot launch:

- `slices/apps/apps-rust/migrations/0004_seed_wildflower_web_trace_app/` (the
  original self-hosted seed) and
  `0005_first_party_apps_to_cloud/` (the rename to `web-trace-app` + the flip to
  a cloud row served from the published site)
- `slices/gatekeeper/gatekeeper-rust/migrations/0005_seed_wildflower_web_trace_client/`
  and `0006_rename_first_party_app_clients/`

`src/config.ts`'s `clientId` must equal the app id it is launched through, for
both the production and the dev registration — the host's redirect resolver looks
an app up by `client_id`.

## Running the dev server

```bash
vp run -F wildflower-web-trace dev     # strictPort, from slices/apps/dev-app-ports.json
```

Debug builds of the host additionally seed a `web-trace-app-dev` **self-hosted**
row on that port plus its own OAuth client (`apps-rust`'s `seed_dev_apps` /
`gatekeeper-rust`'s `seed_dev_app_clients`), so the homescreen carries a "Web
Trace (Dev)" tile that launches whatever is serving that port —
the vite dev server when it is up, otherwise the host's copy of the vendored
build. The port has a single source, `slices/apps/dev-app-ports.json`: the vite
config reads it and `apps-rust` embeds it, so the dev server and the row cannot
drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`web-trace-app-dev` id, the seed logs a warning and leaves it untouched rather
than adopting it — you get no dev tile until that app is renamed.

## Testing

- The auth wiring in isolation — the verbatim base prepend (a property over
  arbitrary server bases), the relative/absolute split, and that an absent token
  sets no header rather than a
  `Bearer` with nothing after it — is
  [`fhir-r4-react`'s `self-hosted-runtime.test.ts`](../../slices/emr/fhir-r4-react/src/smart/self-hosted-runtime.test.ts),
  moved there with the code it covers.
- `app-root.test.tsx` — chrome-level tests for `AppRoot`. Mocks `App` and
  `ConnectMenu` with lightweight stubs (via `vi.mock`) and passes `launched`
  explicitly so each branch is exercised without URL games. The `launched: true`
  case asserts the slim `BrandBar` (a link with `aria-label="Wildflower, home"`
  pointing at `https://wildflowerhealth.io/`) and the absence of full chrome;
  `launched: false` asserts `SiteHeader`, `ConnectMenu`, `SiteFooter` with
  absolute nav hrefs.
- `app.test.tsx` — the whole tree over a stub transport. It asserts the URL and
  the `Authorization` header that actually went on the wire, so the two
  self-hosted-origin facts above are pinned rather than assumed. It also walks
  the panel down to an exchange detail and back out, which is what would catch a
  detail surface reappearing here: a second `Back to exchanges` on the page makes
  `getByRole` raise, and the walk back out asserts the panel's "All recordings"
  control — a URL match alone would pass on either surface, since a session row's
  subtitle is its host. Two further cases drive the tabstrip and assert the
  unselected panel is **absent**, not hidden.

Body decoding and header-row keying are the slice's tests now, in
`web-trace-react`'s `attachments/` and `exchanges/`.

## References

- [emr slice AGENTS.md](../../slices/emr/AGENTS.md) — the shared self-hosted
  SMART runtime this app imports (`fhir-r4-react/smart`), and the three
  auth-critical properties it must keep.
- [web-trace-react AGENTS.md](../../slices/web-trace/web-trace-react/AGENTS.md) —
  the viewer this app mounts, and its traps.
- [web-trace slice AGENTS.md](../../slices/web-trace/AGENTS.md) — the
  store-raw / view-raw / anonymize-at-export asymmetry.
- [Store and Install Explanation](../../docs/Apps/Store%20and%20Install%20Explanation.md)
  — how a seeded self-hosted app is registered, ported, and served.
- [self-hosted-apps README](../../slices/apps/self-hosted-apps/README.md) — the
  vendored-build sync this app's `outDir` feeds.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.

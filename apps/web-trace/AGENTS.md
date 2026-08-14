# AGENTS.md — apps/web-trace

The Web Trace viewer, shipped as a self-hosted SMART-on-FHIR app. It wraps
[`web-trace-react`](../../slices/web-trace/web-trace-react/AGENTS.md) — the app
itself holds no viewing logic, only the wiring a self-hosted origin needs.

`apps/medications-app` is the template for the bundle shape (two HTML entries,
a relative `base`, a build straight into the vendored `self-hosted-apps` tree).
What is _not_ shared with it is the auth wiring below.

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

- **It is served from its own origin** (`http://127.0.0.1:8091/` on device, a
  tunnel subdomain through the front) — not the API's. The typed FHIR client
  emits _relative_ paths (`/fhir-r4/DocumentReference`), which would resolve
  against port 8091 and 404. So the layer prefixes them with the FHIR base the
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
  now** — the `iss`-prefix reconciliation that returns a **`Left`** rather than
  guessing, the bearer token that rides only the requests the layer addressed,
  and the
  transport staying a parameter. They are unchanged, but they are enforced in
  `fhir-r4-react/smart`; the guardrail that spells all three out is in
  [slices/emr/AGENTS.md](../../slices/emr/AGENTS.md). What is still this app's is
  that `app.tsx` names the real transport, and `app.test.tsx` pins what goes on
  the wire end to end.
- **The history is a memory history.** This page is the OAuth redirect target,
  so its real URL carries `?code=…&state=…`. A browser history would try to
  match that against the route tree, and any navigation would rewrite the URL
  the SMART handshake is still reading.
- **Plain `FetchHttpClient.layer`, not `telemetry-react`'s
  `webHttpClientLayer`.** The app is registered `local_only = 1`, and the
  telemetry layer's OTLP exporter is exactly the kind of outbound request that
  claim rules out.
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
  `local_only = 1` claim has no code here to violate it.
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

## Seeded registration

The app is seeded by two migrations that must land together — an app
registration whose `client_id` has no registered client cannot launch:

- `slices/apps/apps-rust/migrations/0004_seed_wildflower_web_trace_app/`
- `slices/gatekeeper/gatekeeper-rust/migrations/0005_seed_wildflower_web_trace_client/`

The `clientId` in `src/config.ts` must equal the app id in both. Port **8091**,
above `MIN_UPLOAD_PORT` (8082) so shipping it does not consume a low upload port.

## Testing

- The auth wiring in isolation — prefix derivation (including the `Left` on an
  unaddressable `iss`), the relative/absolute split, and that an absent token
  sets no header rather than a
  `Bearer` with nothing after it — is
  [`fhir-r4-react`'s `self-hosted-runtime.test.ts`](../../slices/emr/fhir-r4-react/src/smart/self-hosted-runtime.test.ts),
  moved there with the code it covers.
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

# AGENTS.md — slices/smart-app

The Wildflower chrome every self-hosted SMART app boots through. The SMART
wiring (the handshake, the self-hosted runtime, the launch-error contract, the
standalone-launch primitives) is `fhir-r4-react/smart`'s, and the Wildflower
look (header, footer, brand bar, landing layout) is `branding-react`'s. This
slice is where the two meet, so neither has to know about the other.

## Package roles

- **`smart-app-react`** — the only package. There is no `-core`: everything
  here is UI or DOM boot code.
  - `SmartAppRoot({ app, standalone, telemetry, launched?, children })` — the
    app root. `telemetry` (`SmartAppTelemetry`: `dsn`, `app`) names where the
    app reports once the visitor consents: its own Sentry project's DSN and
    the id its events are tagged with.
  - `runSmartLaunchEntry({ launch, loadingMessage })` — the whole `launch.html`
    entry.
  - `ConnectMenu({ target, … })` and its `DEFAULT_SERVER_PRESET_GROUPS` — the
    standalone connect flow. `target: 'fhir-r4'` launches a SMART app against a FHIR R4
    base with `startStandaloneLaunch`; `target: 'wildflower'` hands the Wildflower
    owner UI's own sign-in (`connect`) the picked URL (a Wildflower server's
    API base, or the demo server's FHIR base), and also runs the
    page's "Sign in to …" row (`chosenServer`) and sign-in on arrival
    (`autoConnect`). Either target shows the problem the page arrived with
    (`arrivalProblem`).
  - `LoadingLine`, `LoadingMoreLine` and `ReadFailureLine` — the read-status
    vocabulary an app's page speaks: `Loading…` (or `Loading <subject>…`)
    before anything lands, `Loading more…` while later pages arrive, and
    `Could not load <subject>: <reason>` for a failed read. Pair them with
    `react-kitchen-sink`'s `pagedQueryStatusOf` for a paged read.

Consumers: `apps/medications-app`, `apps/health-viewer`, `apps/importer-web`,
`apps/web-trace` and `apps/synthetic-data-app` mount `SmartAppRoot` and
`runSmartLaunchEntry`; the first two speak the read-status lines, as does
`synthetic-data-react`'s screen; `apps/fhir-sync-pebble-web` is
standalone-only, so it mounts `SmartAppRoot` with no launch entry;
`apps/wildflower-react`'s landing uses only `ConnectMenu`, with
`target: 'wildflower'`.

## Booting an app

An app's two entries are each a few lines:

- `main.tsx` imports `react-tundraish/styles` (the design-system stylesheet
  stack, fonts included) before anything else, completes a GitHub Pages 404
  redirect (`restoreRedirectedUrl`), starts `addOsColorSchemeListener()`, and
  renders `<SmartAppRoot app="…" standalone={standaloneSmartConfig} telemetry={smartAppTelemetry}><App /></SmartAppRoot>`.
  `config.ts` pairs the DSN, read from the app's own `VITE_SENTRY_DSN_<APP>`
  build variable (typed in `env.d.ts`, named in `.env.example`), with the
  app's id as `smartAppTelemetry`.
- `launch-main.tsx` imports the same stylesheet module and calls
  `runSmartLaunchEntry`.

`branding-react`'s layout tokens arrive through its JS entry, so an app does not
import `branding-react/styles.css` itself.

## Guardrails

- **The consent dialog comes first, and nothing starts telemetry before a
  yes.** `SmartAppRoot` renders both branches inside `telemetry-react`'s
  `TelemetryConsentGate`, so until the visitor has answered the page is the
  dialog alone: the connect menu does not mount, the app does not mount, and
  no query runs. The answer goes to `telemetry-react`'s
  `useConsentedTelemetryStart`, which starts Sentry only when a switch is on;
  the owner UI's web entry starts through the same hook, so the start logic
  lives there, not here. The FHIR host tag waits for Sentry to run; the launch
  failure the page arrived with is reported once, from the hook's
  `onFirstStart`. The `CrashReportingBoundary`s (`telemetry-react`) around
  the launched app and around the connect menu, and the `QueryClient`'s
  `onQueryError`, call `Sentry.captureException` unconditionally, which does
  nothing on an SDK that was never initialized.
  `onQueryError` skips the handshake query (`isSmartHandshakeQuery`): a failed
  handshake comes back to the root as its launch failure and is reported
  there, so it is reported once. An app keeps the plain
  `FetchHttpClient.layer` and never provides `webTelemetryLayerFromEnv` or
  calls `initWebTelemetryFromEnv`: those start
  telemetry from the build's env without asking. Tests cover each branch
  directly (`smart-app-root.test.tsx`).
- **The telemetry status control is on both branches.** It sits in
  `BrandBar`'s `trailing` slot on the launched branch and in
  `AppLandingPage`'s `aboveFooter` row on the standalone branch, and reopens
  the dialog.
- **The branch is latched on mount.** `SmartAppRoot` reads
  `shouldCompleteSmartLaunch()` (or the `launched` prop) and `launchErrorFrom()`
  once, in `useState` initializers. fhirclient's `oauth2.ready()` strips
  `code`/`state` once the exchange completes, so re-reading the URL on a later
  render would flip a finished launch back to the connect menu under the
  authenticated app — and drop the failure banner a launch landed with.
- **One `QueryClient` per page, built by the shell.** `SmartAppRoot` builds it
  with `buildSmartQueryClient({ onQueryError })` and provides it at the root,
  where the app's `useSmartHandshake` runs; the app hands that same instance to
  `buildSmartRouterContext`. The shell reads the handshake's result off that
  client with `whenSmartHandshakeReady` rather than running the exchange
  itself. See the `useSmartHandshake` guardrail in
  [slices/emr/AGENTS.md](../emr/AGENTS.md) for why the exchange must run once.
- **Redirect targets are derived from the page URL, in render.** The shell's
  `ConnectMenu` redirect, the launch page's, and a failed handshake's return
  are all `fhir-r4-react/smart`'s `appRootRedirectUri(href)` (the page's
  directory), so the bundle works at whatever origin and path it is served
  from, and no module reads `window` as a side effect of being imported.
- **A failed launch goes to the app root, never a dead end.** A rejected
  `authorizeSmartLaunch` on the launch page is handed to the app root through
  `launchErrorRedirect`, where `SmartAppRoot` latches it and hands it to the
  `ConnectMenu` as its `arrivalProblem`; the contract is `fhir-r4-react/smart`'s
  `launch-error.ts`.
- **`ConnectMenu` probes before it connects, and `unreachable` ≠ `open`.** It
  renders inside `AppLanding` on the standalone branch: launch buttons grouped
  under each known server's name and address (`server-presets.ts`'s
  `serverPresetGroupsFor`) as hairline-separated blocks in the landing page's
  vocabulary, with a Wildflower-hosted group — `https://` [subdomain]
  `.wildflowerhealth.io` — after the first group (the local server in the
  default groups), then a free-URL form. Every URL is built for the `target`: a FHIR base
  (`…/fhir-r4`) for `fhir-r4`, the server's origin for `wildflower` — except
  the demo server's, a FHIR base under either target. The `wildflower`
  caller's `connect` gets only the URL, a Wildflower server's API base or a
  plain SMART server's FHIR base: `gatekeeper-core`'s discovery tries
  `{url}/fhir-r4` first and the URL itself only on a 404. A free entry under
  `wildflower` loses a trailing `/fhir-r4` (`withoutFhirR4Mount`), so the owner
  UI's `?server=` is always the API base. The
  subdomain is checked as dot-separated DNS labels before it is spliced into a
  URL, and it and the free entry are validated with `normalizeServerUrl` in
  plain `type="text"` inputs, never `type="url"` — HTML5 constraint validation
  would block the submit handler and mask the message. An entry's validation
  message shows inside its own form, beside the field. On an https page, a pick
  of a plain-http server off loopback is refused before connecting, for either
  target, with `insecureTargetReason`'s explanation in the banner beside where
  the connect started (re-exported by `fhir-r4-react/smart`, like `normalizeServerUrl`; the scheme
  read when the pick is made). `startStandaloneLaunch`'s
  `unreachable` outcome, like a problem the `wildflower` caller's `connect`
  reports, is shown as a retryable error banner beside where the connect
  started (the bottom for a pick) rather than connecting. A `connect` that
  throws synchronously is reported like one that rejects. For either target, a loopback pick's problem on an https page is
  followed by `fhir-r4-react/smart`'s Local Network Access hint
  (`withLocalNetworkAccessHint`, the page's scheme read when the pick is made),
  so every app on the published site names Chrome's prompt; a caller's
  `connect` returns its problem without the hint. A page restored from the back-forward cache mid-launch comes
  back idle rather than disabled; why an `unreachable` probe must never degrade
  to `open` is the standalone-launch guardrail in
  [slices/emr/AGENTS.md](../emr/AGENTS.md).
- **`ConnectMenu` runs every sign-in on its page, through one state.** A pick,
  the `wildflower` target's "Sign in to {url}" row for the server the page is
  already pointed at (`chosenServer`, with its `blockedReason` shown and the
  button disabled when the page cannot reach it), and the sign-in on arrival
  (`autoConnect`, read on mount only and guarded by a ref, so StrictMode and a
  later render that points the page elsewhere cannot start a second one) all go
  through the same `connect` and the same `launching` state. There is one busy
  flag, one problem at a time, and one `pageshow` reset, so Back from the
  authorization server leaves nothing disabled. The page's `arrivalProblem`
  (the latched launch error, or the owner UI's boot redemption failure) shows
  at the top until any connect starts; a connect's own problem shows beside
  where it started, at the top for the chosen server and at the bottom for a
  pick. A page keeps only the policy (which server, whether to sign in on
  arrival, what `connect` means) and holds no sign-in state of its own.

## References

- [slices/emr/AGENTS.md](../emr/AGENTS.md) — the SMART primitives this slice
  builds on
- [slices/branding/AGENTS.md](../branding/AGENTS.md) — the chrome it renders,
  and "The app landing page"

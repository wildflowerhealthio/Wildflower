# AGENTS.md — slices/smart-app

The Wildflower chrome every self-hosted SMART app boots through. The SMART
wiring (the handshake, the self-hosted runtime, the launch-error contract, the
standalone-launch primitives) is `fhir-r4-react/smart`'s, and the Wildflower
look (header, footer, brand bar, landing layout) is `branding-react`'s. This
slice is where the two meet, so neither has to know about the other.

## Package roles

- **`smart-app-react`** — the only package. There is no `-core`: everything
  here is UI or DOM boot code.
  - `SmartAppRoot({ app, standalone, launched?, children })` — the app root.
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

Consumers: `apps/medications-app`, `apps/importer-web` and `apps/web-trace`
mount `SmartAppRoot` and `runSmartLaunchEntry`; `apps/fhir-sync-pebble-web` is
standalone-only, so it mounts `SmartAppRoot` with no launch entry;
`apps/wildflower-react`'s landing uses only `ConnectMenu`, with
`target: 'wildflower'`.

## Booting an app

An app's two entries are each a few lines:

- `main.tsx` imports `react-tundraish/styles` (the design-system stylesheet
  stack, fonts included) before anything else, completes a GitHub Pages 404
  redirect (`restoreRedirectedUrl`), starts `addOsColorSchemeListener()`, and
  renders `<SmartAppRoot app="…" standalone={standaloneSmartConfig}><App /></SmartAppRoot>`.
- `launch-main.tsx` imports the same stylesheet module and calls
  `runSmartLaunchEntry`.

`branding-react`'s layout tokens arrive through its JS entry, so an app does not
import `branding-react/styles.css` itself.

## Guardrails

- **The branch is latched on mount.** `SmartAppRoot` reads
  `shouldCompleteSmartLaunch()` (or the `launched` prop) and `launchErrorFrom()`
  once, in `useState` initializers. fhirclient's `oauth2.ready()` strips
  `code`/`state` once the exchange completes, so re-reading the URL on a later
  render would flip a finished launch back to the connect menu under the
  authenticated app — and drop the failure banner a launch landed with.
- **One `QueryClient` per page, built by the shell.** `SmartAppRoot` builds it
  with `buildSmartQueryClient()` and provides it at the root, where the app's
  `useSmartHandshake` runs; the app hands that same instance to
  `buildSmartRouterContext`. See the `useSmartHandshake` guardrail in
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

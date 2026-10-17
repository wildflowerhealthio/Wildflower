# AGENTS.md — slices/smart-app-react

The Wildflower chrome every first-party SMART app boots through. The SMART
wiring (the handshake, the SMART runtime, the launch-error contract, the
standalone-launch primitives) is `fhir-r4-react/smart`'s, and the Wildflower
look (header, footer, brand bar, landing layout) is `branding-react`'s. This
package is where the two meet, so neither has to know about the other.

## Exports

Everything here is UI or DOM boot code. What the connect menu offers, as
pure data (the relay entry, the preset groups, what an entry names or why
it names none, the menu's copy), is
`smart-app-core`'s, so a page that is not React (the server-docs console)
offers the same choices; this package re-exports its preset groups.

- `SmartAppRoot({ app, registration, telemetry, launched?, replaceLocation?, children })`
  — the app root, and the app's one page: it starts a SMART launch its URL
  carries, completes the callback, and shows the landing on a plain visit.
  `registration` is the app's SMART registration (`clientId` and `scope`),
  for a launch the URL carries and for the connect menu alike. `telemetry`
  (`SmartAppTelemetry`: `dsn`, `app`) names where the app reports once the
  visitor consents: its own Sentry project's DSN and the id its events are
  tagged with. `replaceLocation` replaces the page in the session history
  when it leaves for the app root, and defaults to `window.location.replace`.
- `ConnectMenu({ target, … })` and its `DEFAULT_SERVER_PRESET_GROUPS` — the
  standalone connect flow. `target: 'fhir-r4'` launches a SMART app against a FHIR R4
  base with `startStandaloneLaunch`; `target: 'wildflower'` hands the Wildflower
  launcher's own sign-in (`connect`) the picked URL (a Wildflower server's
  API base, or the demo server's FHIR base), and also runs the
  page's "Sign in to …" row (`chosenServer`) and sign-in on arrival
  (`autoConnect`). Either target shows the problem the page arrived with
  (`arrivalProblem`).
- `openSmartAppPage(import.meta.url)`, its `SmartAppPage` (`history`,
  `basepath`), and `SmartHandshakeGate({ connecting, children })` — what a
  routed app's router runs over, and the gate it is built under; see
  [Routing a SMART app](#routing-a-smart-app).
- `LoadingLine`, `LoadingMoreLine` and `ReadFailureLine` — the read-status
  vocabulary an app's page speaks: `Loading…` (or `Loading <subject>…`)
  before anything lands, `Loading more…` while later pages arrive, and
  `Could not load <subject>: <reason>` for a failed read. Pair them with
  `react-kitchen-sink`'s `pagedQueryStatusOf` for a paged read.
- The patient choice, for an app that picks the patient itself after
  sign-in rather than asking the authorization server for `launch/patient`:
  - `PatientChoice` — one patient (`{ kind: 'patient', patientId }`) or
    every patient (`{ kind: 'all-patients' }`). `patientScopeOf` turns it
    into the `patientId: string | null` a `fhir-r4-react/smart` reader
    takes (`null` reads unscoped); `patientChoiceKeyOf` into one string,
    distinct per choice, for a React key, a query key, or `?patient=`
    (`PATIENT_PARAM`), and `patientChoiceOfKey` back, for an app whose
    router owns `?patient=` as a search param.
  - `usePatientChoice(launchPatientId)` — the choice the page reads under,
    `None` while the reader is choosing, with `choosePatient` and
    `changePatient`.
  - `PatientPicker({ client, onPatientChoice })` — "All patients" first,
    then every patient the session can see (`fetchPatientPage`, name and
    birth date per row, sorted by family name, "More patients" while the
    server has more).
  - `PatientChoiceLine({ client, patientChoice, onPatientChange })` — the
    line under an app's title: `Name · born YYYY-MM-DD` (one `fetchPatient`
    read) or "All patients", and a "Change patient" link.

Consumers: `apps/medications/medications-web`, `apps/plots/plots-web`, `apps/strength/strength-web`,
`apps/importer-web` and `apps/synthetic-data/synthetic-data-web` mount
`SmartAppRoot`, which an EHR launches at the app root; the first three speak
the read-status lines, as does `synthetic-data-react`'s screen, and pick the
patient with the patient choice; `apps/fhir-sync-pebble/fhir-sync-pebble-web` mounts
`SmartAppRoot` too, but is only ever opened standalone;
`apps/launcher/launcher-web`'s landing uses only `ConnectMenu`, with
`target: 'wildflower'`.

## Booting an app

An app has one entry, `index.html`, and it is a few lines:

- `main.tsx` imports `react-tundraish/styles` (the design-system stylesheet
  stack, fonts included) before anything else, completes a GitHub Pages 404
  redirect (`restoreRedirectedUrl`), starts `addOsColorSchemeListener()`, and
  renders `<SmartAppRoot app="…" registration={smartRegistration} telemetry={smartAppTelemetry}><App /></SmartAppRoot>`.
  `config.ts` holds the app's SMART registration (`smartRegistration`), and pairs
  the DSN, read from the app's own `VITE_SENTRY_DSN_<APP>` build variable
  (typed in `env.d.ts`, named in `.env.example`), with the app's id as
  `smartAppTelemetry`.

The app root is the URL an EHR, the desktop base and the launcher's plain
SMART Home launch the app at (`?iss=…&launch=…`, or a lone `?iss=` for a
standalone launch against that server), so there is no separate launch page.

`branding-react`'s layout tokens arrive through its JS entry, so an app does not
import `branding-react/styles.css` itself.

## Routing a SMART app

An app with a router (`apps/medications/medications-web`,
`apps/importer-web`) boots it through this package, in an order that is
load-bearing:

- **`main.tsx` opens the page once.** `openSmartAppPage(import.meta.url)`
  creates the window's browser history for the page's life (creating it
  touches no URL; it only tags the current entry's state) and reads the
  served directory, the router's basepath, off the entry module's URL
  (`servedDirectoryOf`: the directory above `assets/` in a build, above
  `src/` under the dev server). Never off the page's URL: a load can land on
  a deep route (a dev or preview server's SPA fallback serving `/import/`),
  and that route would become the basepath. `main.tsx` hands the
  `SmartAppPage` to its `AppRoot`, which hands it to `App`.
- **The router is built only under `SmartHandshakeGate`.** The app root is
  the OAuth redirect target, so its URL carries `?code=…&state=…` until
  fhirclient takes them out as the exchange completes. A router matches the
  URL and redirects `/` to a tab, so it must not exist while the exchange
  still reads that URL. The gate runs `useSmartHandshake`, shows the app's
  `connecting` element meanwhile, shows a failed exchange and carries it to
  the app root (`useLaunchFailureRedirect`), and renders `children(client)`
  once ready; the app builds its router there, once (`useState` or a memo on
  its context), so a tab change is a navigation inside it, never a rebuild.
  A launch URL never reaches the router at all: `SmartAppRoot` starts the
  launch before the app mounts.
- **A deep link comes back through the 404 page.** On GitHub Pages a deep
  route is served by the site's 404 page, whose redirect to the app root
  `main.tsx` completes with `branding-core`'s `restoreRedirectedUrl` before
  anything reads the URL. The basepath does not depend on it.

## Guardrails

- **A launch waits for the consent answer, then starts once.** When
  `arrivingSmartLaunchFrom` finds one (`iss`, with or without an EHR's
  `launch`, and no callback), `SmartAppRoot` renders `LaunchPage`
  (`Launching <app name>…` under `BrandBar`, the name from
  `APP_DESCRIPTIONS`) inside the consent gate and a `CrashReportingBoundary`,
  like the other branches, and authorizes with `authorizeFromLaunchPage` once
  it mounts. A returning visitor's stored answer skips the dialog, so their
  launch starts at once. A launch older than 5 minutes is refused, and the
  failure lands on the connect menu. A ref guards the authorize, as
  `ConnectMenu`'s `autoConnect` is guarded, so StrictMode's second effect run
  cannot spend the launch twice. A page restored from the back-forward cache
  after leaving for the authorization server does not re-run the authorize:
  it replaces itself with the bare app root (`appRootRedirectUri`), a plain
  visit with the connect menu. A launch that fails before it leaves replaces
  the page with the app root carrying `?launchError`. Both navigations go
  through `SmartAppRoot`'s `replaceLocation` prop, which defaults to
  `window.location.replace` and lets the tests observe them.
- **The consent dialog comes first, and nothing starts telemetry before a
  yes.** `SmartAppRoot` renders every branch inside
  `telemetry-react`'s `TelemetryConsentGate`, so until the visitor has
  answered the page is the dialog alone: no launch is authorized, the connect
  menu does not mount, the app does not mount, and no query runs. The answer goes to `telemetry-react`'s
  `useConsentedTelemetryStart`, which starts Sentry only when a switch is on;
  the launcher's web entry starts through the same hook, so the start logic
  lives there, not here. The FHIR host tag waits for Sentry to run; the launch
  failure the page arrived with is reported once, from the hook's
  `onFirstStart`. The `CrashReportingBoundary`s (`telemetry-react`) around
  the launch page, the launched app and the connect menu, and the `QueryClient`'s
  `onQueryError`, call `Sentry.captureException` unconditionally, which does
  nothing on an SDK that was never initialized.
  `onQueryError` skips the handshake query (`isSmartHandshakeQuery`): a failed
  handshake comes back to the root as its launch failure and is reported
  there, so it is reported once. An app keeps the plain
  `FetchHttpClient.layer`. Tests cover each branch
  directly (`smart-app-root.test.tsx`).
- **The telemetry status control is on the launched and standalone branches.** It sits in
  `BrandBar`'s `trailing` slot on the launched branch and in
  `AppLandingPage`'s `aboveFooter` row on the standalone branch, and reopens
  the dialog.
- **The case is latched on mount.** `SmartAppRoot` reads
  `shouldCompleteSmartLaunch()` and `arrivingSmartLaunchFrom` (or the
  `launched` prop) and `launchErrorFrom()` once, in `useState` initializers. fhirclient's `oauth2.ready()` strips
  `code`/`state` once the exchange completes, so re-reading the URL on a later
  render would flip a finished launch back to the connect menu under the
  authenticated app — and drop the failure banner a launch landed with.
- **One `QueryClient` per page, built by the shell.** `SmartAppRoot` builds it
  with `buildSmartQueryClient({ onQueryError })` and provides it at the root,
  where the app's `useSmartHandshake` runs; the app hands that same instance to
  `buildSmartRouterContext`. The shell reads the handshake's result off that
  client with `whenSmartHandshakeReady` rather than running the exchange
  itself. See the `useSmartHandshake` guardrail in
  [slices/fhir/AGENTS.md](../fhir/AGENTS.md) for why the exchange must run once.
- **Redirect targets are derived from the page URL, in render.** The shell's
  `ConnectMenu` redirect, a launch the URL carries, and a failed handshake's
  return are all `fhir-r4-react/smart`'s `appRootRedirectUri(href)` (the page's
  directory), so the bundle works at whatever origin and path it is served
  from, and no module reads `window` as a side effect of being imported.
- **A failed launch goes to the app root, never a dead end.** A rejected
  `authorizeSmartLaunch` on the launch page is handed to the app root, without
  the launch, through
  `launchErrorRedirect`, where `SmartAppRoot` latches it and hands it to the
  `ConnectMenu` as its `arrivalProblem`; the contract is `fhir-r4-react/smart`'s
  `launch-error.ts`.
- **`ConnectMenu` probes before it connects, and `unreachable` ≠ `open`.** It
  renders inside `AppLanding` on the standalone branch: first an "Official
  Wildflower Relay" entry, whose relay name field is subtitled with where the
  server is found (`https://[Name].relay.wildflowerhealth.io`), then launch
  buttons grouped under each known server's name and address
  (`smart-app-core`'s `serverPresetGroupsFor`; the demo server, with no
  local server) as hairline-separated blocks in the landing page's
  vocabulary, then a free-URL form. Every URL is a FHIR base, the same
  under either `target`: a Wildflower server's origin (it serves FHIR at its
  root), and the demo server's own base. The `wildflower` caller's `connect`
  gets only the URL; `authorization-core`'s discovery reads which kind of server
  answers there (a Wildflower server lists the `wildflower-server`
  capability). The
  relay name is checked as a single DNS label before it is spliced into a
  URL, and it and the free entry are validated with `normalizeServerUrl` in
  plain `type="text"` inputs, never `type="url"` — HTML5 constraint validation
  would block the submit handler and mask the message. An entry's validation
  message shows inside its own form, beside the field. On an https page, a pick
  of a plain-http server off loopback is refused before connecting, for either
  target, with `insecureTargetReason`'s explanation in the banner beside where
  the connect started (re-exported by `fhir-r4-react/smart`, like `normalizeServerUrl`; the scheme
  read when the pick is made). `startStandaloneLaunch`'s
  `unreachable` and `unusable` outcomes, a launch it rejects (an authorize
  URL `authorizeSmartLaunch` refuses to go to), and a problem the
  `wildflower` caller's `connect` reports, are shown as a retryable error
  banner beside where the connect started (the bottom for a pick) rather than
  connecting. A `connect` that
  throws synchronously is reported like one that rejects. For either target, a loopback pick's problem on an https page is
  followed by `fhir-r4-react/smart`'s Local Network Access hint
  (`withLocalNetworkAccessHint`, the page's scheme read when the pick is made),
  so every app on the published site names Chrome's prompt; a caller's
  `connect` returns its problem without the hint. A page restored from the back-forward cache mid-launch comes
  back idle rather than disabled; why an `unreachable` probe must never degrade
  to `open` is the standalone-launch guardrail in
  [slices/fhir/AGENTS.md](../fhir/AGENTS.md).
- **`ConnectMenu` runs every sign-in on its page, through one state.** A pick,
  the `wildflower` target's "Sign in to {url}" row for the server the page is
  already pointed at (`chosenServer`, with its `blockedReason` shown and the
  button disabled when the page cannot reach it), and the sign-in on arrival
  (`autoConnect`, read on mount only and guarded by a ref, so StrictMode and a
  later render that points the page elsewhere cannot start a second one) all go
  through the same `connect` and the same `launching` state. There is one busy
  flag, one problem at a time, and one `pageshow` reset, so Back from the
  authorization server leaves nothing disabled. The page's `arrivalProblem`
  (the latched launch error, or the launcher's boot redemption failure) shows
  at the top until any connect starts; a connect's own problem shows beside
  where it started, at the top for the chosen server and at the bottom for a
  pick. A page keeps only the policy (which server, whether to sign in on
  arrival, what `connect` means) and holds no sign-in state of its own.

## The patient choice

- **`?patient=` is the choice's only home.** `?patient=<id>` is one patient,
  `?patient=*` every patient (`*` is outside FHIR's id grammar, so no id is
  ever it), and an absent or empty `patient` is no choice yet
  (`decodePatientChoice` / `withPatientChoice` in `patient-choice.ts`).
- **The URL wins over the launch.** `usePatientChoice` reads the URL once, on
  mount; without a choice there it opens on the launch's `client.patient.id`
  (an EHR launch from a patient's record), and with neither it has none and
  the page shows the picker. A reload keeps the reader's own pick.
- **Nothing is written until the reader chooses**, and a write touches only
  `patient`: before the handshake completes the URL still carries the OAuth
  `code` / `state` fhirclient reads, and an app's own query state (the health
  viewer's selection) sits beside it. A choice is written with
  `history.replaceState`, never `pushState`.
- **Changing the patient only reopens the picker.** The URL keeps the last
  choice until another is made, so a reload mid-change returns to it.
- **An app decides what "All patients" means for it.** The readers take
  `null` and read unscoped; an app that writes (Strength) keeps its write
  screens behind a chosen patient.

## References

- [slices/fhir/AGENTS.md](../fhir/AGENTS.md) — the SMART primitives this package
  builds on
- [slices/branding/AGENTS.md](../branding/AGENTS.md) — the chrome it renders,
  and "The app landing page"

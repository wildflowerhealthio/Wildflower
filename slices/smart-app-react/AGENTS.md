# AGENTS.md — slices/smart-app-react

The Wildflower chrome every first-party SMART app boots through. The SMART
wiring (the sign-in, the handshake, the SMART runtime, the launch-error
contract, the arrival parse) is `fhir-r4-react/smart`'s, and the Wildflower
look (header, footer, brand bar, landing layout) is `branding-react`'s. This
package is where the two meet, so neither has to know about the other.

## Exports

Everything here is UI or DOM boot code. What the connect menu offers, as
pure data (the relay entry, the preset groups, what an entry names or why
it names none, the menu's copy), is
`smart-app-core`'s, so a page that is not React (the server-docs console)
offers the same choices; this package re-exports its preset groups.

- `SmartAppRoot({ app, registration, telemetry, basepath?, search?, replaceLocation?, children })`
  — the app root, and the app's one page: it starts a SMART launch its URL
  carries, completes a sign-in that came back, and shows the landing on a
  plain visit. `registration` is the app's `SmartRegistration` (`clientId`
  and `scope`), for a launch the URL carries, the connect menu and the
  sign-in's return alike. `basepath` is a routed app's
  (`SmartAppPage.basepath`): the OAuth redirect URI is that directory,
  whichever route the page was opened at; without it, the page URL's own
  directory. `search` is the query string it parses into its `RootArrival`
  (default `window.location.search`; tests pass one). `telemetry`
  (`SmartAppTelemetry`: `dsn`, `app`) names where the app reports once the
  visitor consents: its own Sentry project's DSN and the id its events are
  tagged with. `replaceLocation` replaces the page in the session history
  when it leaves for the app root, and defaults to `window.location.replace`.
- `ConnectMenu({ target, … })` and its `DEFAULT_SERVER_PRESET_GROUPS` — the
  standalone connect flow. `target: 'fhir-r4'` signs a SMART app in to a FHIR R4
  base with `redirectToSignIn`; `target: 'wildflower'` hands the Wildflower
  launcher's own sign-in (`connect`) the picked URL (a Wildflower server's
  API base, or the demo server's FHIR base), and also runs the
  page's "Sign in to …" row (`chosenServer`) and sign-in on arrival
  (`autoConnect`). Either target shows the problem the page arrived with
  (`arrivalProblem`).
- `openSmartAppPage(import.meta.url)`, its `SmartAppPage` (`history`,
  `basepath`), `SmartHandshakeGate({ connecting, children })`,
  `SignInLandingContext` (what the root provides the gate, for a test that
  mounts an app without the root) and
  `appRootRedirect(startRoute)` — what a routed app's router runs over, the
  gate it is built under, and what its `/` redirects to; see
  [Routing a SMART app](#routing-a-smart-app).
- `useGrantedScopes()` — the scopes the page's sign-in was granted, as
  `scopes-core` `Scope` values: a connection carries its grant
  (`SmartConnection.grantedScopes`), which may be less than the app's
  `registration.scope` asked for when the Owner unticked scopes on the
  consent card. It reads the runtime `SmartHandshakeGate` provides, as
  `useRunSmart` does; a page handed the connection reads the field directly.
  `scopes-core`'s `Grant.make` turns the list into a grant to check coverage
  against.
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
    distinct per choice, for a React key, a query key, or `?patient=`.
  - `usePatientChoice(launchPatientId)` — the choice the page reads under,
    `?patient=` in the URL, `None` while the reader is choosing, with
    `choosePatient` and `changePatient`, for an app without a router.
  - `usePathPatientChoice()`, `requirePatient(queryClient, runSmart,
    patientId)`, `launchStartRoute(connection)`, `NoPageCard` and
    `NoPatientCard` — the choice for an app whose router names the patient
    in the path; see [Routing a SMART app](#routing-a-smart-app).
  - `PatientPicker({ onPatientChoice })` — "All patients" first,
    then every patient the session can see (`fetchPatientPage`, name and
    birth date per row, sorted by family name, "More patients" while the
    server has more).
  - `PatientChoiceLine({ patientChoice, onPatientChange })` — the
    line under an app's title: `Name · born YYYY-MM-DD` (one `fetchPatient`
    read, which says so when the server has no such patient) or "All
    patients", and a "Change patient" link. Both read through the runtime
    the gate provides (`useRunSmart`).

Consumers: `apps/medications/medications-web`, `apps/plots/plots-web`, `apps/strength/strength-web`,
`apps/assistant/assistant-web`,
`apps/importer-web` and `apps/synthetic-data/synthetic-data-web` mount
`SmartAppRoot`, which an EHR launches at the app root; the first three speak
the read-status lines, as does `synthetic-data-react`'s screen, and they and
the Assistant pick the patient with the patient choice; `apps/fhir-sync-pebble/fhir-sync-pebble-web` mounts
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
`apps/strength/strength-web`, `apps/importer-web`) boots it through this
package, in an order that is load-bearing:

- **`main.tsx` opens the page once.** `openSmartAppPage(import.meta.url)`
  creates the window's browser history for the page's life (creating it
  touches no URL; it only tags the current entry's state) and reads the
  router's basepath off the entry module's URL
  (`basepathOf`: the directory above `assets/` in a build, above
  `src/` under the dev server). Never off the page's URL: a load can land on
  a deep route (a dev or preview server's SPA fallback serving `/import/`),
  and that route would become the basepath. `main.tsx` hands the
  `SmartAppPage` to its `AppRoot`, which hands it to `App`.
- **The router is built only under `SmartHandshakeGate`.** The app root is
  the OAuth redirect target, so its URL carries `?code=…&state=…` until
  the handshake takes them out with the retained sign-in requests. A router
  matches the URL and rewrites it (`/` redirects, below), so it must not
  exist while the exchange still reads that URL. The gate runs
  `useSmartHandshake` on the `SignInLanding` the root provides — it is the
  one place the exchange runs — shows the app's `connecting` element
  meanwhile, shows a failed exchange and carries it to the landing's app
  root (`useRedirectToRootOnFailure`), and once ready tells the root the
  connection (`onSignedIn`), builds the one `SmartRuntime` from it (released
  when the connection changes or the gate unmounts), provides it
  (`useRunSmart`) and renders `children(runtime)`; the app builds its
  router there, once (`useState` or a memo on its context), with
  `buildSmartRouterContext(runtime, queryClient)`, so a tab change is a
  navigation inside it, never a rebuild. A launch URL never reaches the router at all:
  `SmartAppRoot` starts the launch before the app mounts.
- **The patient is in the path.** The routes follow one scheme: `/`, which
  is never a page (below), `/patients` the picker, one patient's pages under
  `/patients/$patientId`, and every patient's pages at routes of the app's
  own (strength's `/workouts`, medications' top-level tabs). The router owns
  no query, so it keeps TanStack's default search parser; a path param is
  the string the address bar holds, so an id such as `1.50` reads as
  itself. Any route reads whose records it shows with
  `usePathPatientChoice()`: the patient `$patientId` names, else every
  patient. `telemetry-core`'s `anonymizeUrl` reads the segment after
  `patients` as an id, so the scheme and that rule change together
  (`patient-route.test.tsx` pins it).
- **The picker is a route.** "Change patient" (the patient line's
  `onPatientChange`) is a plain push to `/patients`, so Back closes it on
  the page it was opened over. A choice pushes the patient's page
  (`/patients/<id>`, whose index opens its first tab, replacing itself) or
  the app's every-patient page, so Back from a choice returns to the
  picker, then to the page before. Patient changes are navigations, so the
  router lives as long as the page.
- **A patient route reads its patient first.** Its `loader` is
  `requirePatient`: the patient read on the cache `PatientChoiceLine` reads
  (`patientQuery`), throwing `notFound()` when the server answers 404 or
  410, which its `notFoundComponent`, `NoPatientCard`, shows as `This
  server has no patient <id>.` in place of the page, the id read from the
  path. Any other failed read lets the page render, its patient line saying
  the read failed. The router sets `notFoundMode: 'root'`, so a path no
  route names, one under a patient too, goes to the root's
  `notFoundComponent`, `NoPageCard` (`There's no page at <path>.`), and the
  patient card only ever means no such patient. Both offer the picker. A
  patient route sets `remountDeps` to its patient id, so nothing one
  patient's pages hold carries over to another's.
- **`/` redirects.** The app's index route's `beforeLoad` throws
  `appRootRedirect(startRoute)`, which replaces `/` in history with the
  route the launch started on (below) when one is saved, else with
  `startRoute`: `launchStartRoute(connection)` (`/patients/<connection.launchPatientId>`
  for a launch with a patient, else `/patients`), or a tab of the app's own
  (the importer's `/import`). Both are router paths, which the router puts
  under its basepath, so the redirect never leaves the app. The callback
  lands on `/`, so a completed launch opens one of them in one history
  entry.
- **A launch from a deep route comes back to that route.** The OAuth
  redirect URI is the app root, so a launch at
  `/patients/123/calendar?iss=…&launch=…` returns there: the basepath
  (`SmartAppRoot`'s `basepath`), never the launch route's own directory,
  which is no registered redirect URI. Before the page leaves,
  `redirectForLaunchRequest` saves the route it sat on, relative to the
  basepath (path, its own query less `SMART_LAUNCH_PARAMS`, and
  fragment), in `sessionStorage` under `RETURN_ROUTE_STORAGE_KEY`
  (`return-route.ts`); a launch at the app root clears it. `/`'s redirect
  reads it and leaves it in place; only a path on the page's own origin,
  other than `/` itself, is read. Every `Visit` and `SignInRefused` (a
  failed launch's `?launchError`, an OAuth `?error`, a page back from the
  back-forward cache, a fresh visit) clears it, so a route one launch saved
  never redirects a later one. A standalone `ConnectMenu` connect
  saves no route: it starts from the landing page.
- **A deep link comes back through the 404 page.** On GitHub Pages a deep
  route is served by the site's 404 page, whose redirect to the app root
  `main.tsx` completes with `branding-core`'s `restoreRedirectedUrl` before
  anything reads the URL. The basepath does not depend on it.

## Guardrails

- **A launch waits for the consent answer, then starts once.** On a
  `LaunchRequest` (`iss`, with or without an EHR's `launch`), `SmartAppRoot`
  renders `LaunchPage` (`Launching <app name>…` under `BrandBar`, the name
  from `APP_DESCRIPTIONS`) inside the consent gate and a
  `CrashReportingBoundary`, like the other branches, and signs in with
  `redirectForLaunchRequest` once it mounts, handing it the arrival it
  already parsed, so the URL is read for a launch once. A returning visitor's stored answer skips the dialog, so their
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
  there, and a defect is thrown to the boundary that reports it, so either
  is reported once. The gate's runtime goes out over the plain
  `FetchHttpClient.layer`. Tests cover each branch
  directly (`smart-app-root.test.tsx`).
- **The telemetry status control is on the launched and standalone branches.** It sits in
  `BrandBar`'s `trailing` slot on the launched branch and in
  `AppLandingPage`'s `aboveFooter` row on the standalone branch, and reopens
  the dialog.
- **The arrival is parsed once, on mount.** `SmartAppRoot` reads its
  `RootArrival` (`fhir-r4-react/smart`'s `rootArrivalFrom` over `search`)
  in a `useState` initializer, and `Match`es on it: `SignInReturn` and
  `SelfAddressedSignInReturn` render the app under the `SignInLanding`
  their gate completes, `SignInRefused` and `Visit` the connect menu with the
  failure either carries, `LaunchRequest` the launch page. Every sign-in
  arrival has its retained sign-in requests taken and the callback scrubbed
  from the URL before anything is redeemed: by
  `completeSignInAfterRedirectHere` for a return, and by
  `discardRefusedSignInAfterRedirectHere` for a `SignInRefused` (a storage
  that will not give them up is reported to Sentry). Re-reading the URL on a
  later render would flip a sign-in back to the connect menu under the
  authenticated app — and drop the failure banner a launch landed with. The
  telemetry `launch` tag is the arrival's: `launching`, `launched` for
  either return, `standalone` for a refusal or a visit.
- **One `QueryClient` per page, built by the shell.** `SmartAppRoot` builds it
  with `buildSmartQueryClient({ onQueryError })` and provides it at the root,
  where the app's `SmartHandshakeGate` runs the handshake; the app hands that
  same instance to `buildSmartRouterContext`. The shell learns the connection
  from the gate (`onSignedIn`), holds it, and tags Sentry with its host once
  telemetry runs, rather than running the exchange itself. See the `useSmartHandshake` guardrail in
  [slices/fhir/AGENTS.md](../fhir/AGENTS.md) for why the exchange must run once.
- **Redirect targets are derived from the page URL, on mount.** The shell's
  `ConnectMenu` redirect, a launch the URL carries, the sign-in's return and
  a failed handshake's way back are all `fhir-r4-react/smart`'s
  `appRootRedirectUri(href, basepath)`, which the root computes once and
  hands the gate in its `SignInLanding`, so the bundle works at whatever
  origin and path it is served from, and no module reads `window` as a side
  effect of being imported.
- **A launch probes its `iss` as the menu probes a pick.** The launch page's
  `redirectToSignIn` signs in to a SMART `iss` at its authorization server
  and to an open one by a self-addressed sign-in, as `ConnectMenu` does.
- **A failed launch goes to the app root, never a dead end.** A
  `redirectToSignIn` on the launch page that fails, or finds the `iss`
  `Unreachable` or `Unusable` (worded by `signInProblem`, as the menu words
  them), is handed to the app root, without
  the launch, through `launchErrorRedirect` (`Effect.match` into its
  `?launchError`), where `SmartAppRoot` reads it as a `Visit`'s launch error
  and hands it to the `ConnectMenu` as its `arrivalProblem`; the contract is `fhir-r4-react/smart`'s
  `launch-error.ts`.
- **`ConnectMenu` probes before it connects, and `Unreachable` ≠ `Open`.** It
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
  read when the pick is made). `redirectToSignIn`'s
  `Unreachable` and `Unusable` outcomes, a sign-in it fails (one that cannot
  retain its request), and a problem the
  `wildflower` caller's `connect` reports, are shown as a retryable error
  banner beside where the connect started (the bottom for a pick) rather than
  connecting. A `connect` that
  throws synchronously is reported like one that rejects. For either target, a loopback pick's problem on an https page is
  followed by `fhir-r4-react/smart`'s Local Network Access hint
  (`withLocalNetworkAccessHint`, the page's scheme read when the pick is made),
  so every app on the published site names Chrome's prompt; a caller's
  `connect` returns its problem without the hint. A page restored from the back-forward cache mid-launch comes
  back idle rather than disabled; why an `Unreachable` probe must never degrade
  to `Open` is the picked-server sign-in guardrail in
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
  (the arrival's launch failure, or the launcher's boot redemption failure) shows
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
  mount; without a choice there it opens on the launch's
  `connection.launchPatientId` (an `Option`; an EHR launch from a patient's
  record), and with neither it has none and
  the page shows the picker. A reload keeps the reader's own pick.
- **Nothing is written until the reader chooses**, and a write touches only
  `patient`: an app's own query state (the health viewer's selection) sits
  beside it. A choice is written with
  `history.replaceState`, never `pushState`.
- **Changing the patient only reopens the picker.** The URL keeps the last
  choice until another is made, so a reload mid-change returns to it.
- **An app decides what "All patients" means for it.** The readers take
  `null` and read unscoped; an app that writes (Strength) keeps its write
  screens behind a chosen patient.

## Root props pass through

As in [react-tundraish](../../global/react-tundraish/AGENTS.md#root-props-pass-through),
a component's props extend its outermost element's, less the ones it sets,
and the rest are spread onto that element before its own attributes, with a
caller's `className` joined through `cn`. `PatientChoiceLine` takes `<div>`
props, so a caller anchors a walkthrough step or adds an `id` on it directly.

## References

- [slices/fhir/AGENTS.md](../fhir/AGENTS.md) — the SMART primitives this package
  builds on
- [slices/branding/AGENTS.md](../branding/AGENTS.md) — the chrome it renders,
  and "The app landing page"

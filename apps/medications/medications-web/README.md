# medications-web

The first-party Medications SMART-on-FHIR app. One HTML entry, `index.html`: the
app root, which starts a SMART launch its URL carries (an EHR's `iss` and
`launch`, or a lone `iss`), completes the handshake and renders the app when a
callback is in the URL, and shows the standalone connect menu, where the user
picks a FHIR server, on a bare visit.

## Boot structure

The entry runs on `smart-app-react`, the chrome every first-party SMART app
boots through (see [slices/smart-app-react/AGENTS.md](../../../slices/smart-app-react/AGENTS.md)).

`src/main.tsx` is the `index.html` entry: it imports the design-system
stylesheet module (`react-tundraish/styles` — tundra-css, react-tundraish and
the self-hosted fonts, in that order),
completes a GitHub Pages 404 redirect, wires the OS colour-scheme listener,
and renders `<AppRoot page={openSmartAppPage(import.meta.url)} />` inside
`<StrictMode>`: the page's one history and the served directory, which the
router navigates and runs under once it is built.

`src/app-root.tsx` exports `AppRoot`: `<SmartAppRoot app="medications"
registration={smartRegistration} telemetry={smartAppTelemetry}>` around
`<App page={page} />`. `SmartAppRoot` shows the telemetry consent dialog first, then
latches on mount which of three cases the URL is:

- **Launch** (`iss`, with or without an EHR's `launch`, and no callback) —
  shows a loading line under `BrandBar` and starts the authorize redirect,
  sending a failed launch back to the app root as `?launchError`.
- **Launched** (OAuth callback present) — renders `<BrandBar />` (a slim brand
  link back to the marketing site, with the telemetry status control at its
  end) above `<App />`.
- **Standalone** (bare visit) — renders the full Wildflower chrome:
  `<SiteHeader>`, the app's `<AppLanding>` introduction beside `<ConnectMenu>`,
  the telemetry status control, `<SiteFooter>`, with nav links resolving as
  absolute URLs back to `wildflowerhealth.io`.

The launched and standalone branches share the root's single
`QueryClientProvider`.

`smartAppTelemetry` in `src/config.ts` names the app's Sentry project through
the `VITE_SENTRY_DSN_MEDICATIONS_WEB` build variable (see `.env.example`).
Nothing is reported until the visitor says yes.

`AppRoot` takes the `page` the app's router runs over and an optional
`launched` prop (defaults to the live URL checks) so the launched and
standalone branches are testable without URL manipulation. The package exports
`AppRoot` via the `source` condition for future aggregator-shell composition.

## The patient

The page reads one patient's `MedicationRequest`s, or every patient's. Whose
is the root route's `?patient=` search param (`<id>`, or `*` for All
patients), else the launch's `client.patient.id`, else none, which the root
shows as `smart-app-react`'s `PatientPicker` ("All patients" first, then every
patient by name and birth date). One patient's requests are searched with
`patient=`; All patients searches unscoped. Under the H1, `PatientChoiceLine`
names the choice with a "Change patient" link, above the chunk bar.

The root's patient choosing is `smart-app-react`'s `useRoutedPatientPicker`
(`routes/-chosen-patient.ts`), and both of its moves are navigations, each
pushing a history entry. "Change patient" adds `?picking-patient=1` to the
open tab, keeping its `?patient=`, so Back closes the picker on the page it
was opened over. A choice lands on the open tab with the new `?patient=` and
no flag, and every later navigation keeps `?patient=` (and only it), so each
entry names the patient it shows: Back from a choice returns to the picker,
then to the patient before, and a reload or a shared link opens the patient
the address bar names. The router reads and writes the query as plain
strings, so a numeric FHIR id stays `?patient=123`.

## Tabs

Once the handshake completes, `<App />` hands the page to a TanStack router
(file routes under `src/routes/`, the tree generated into the git-ignored
`src/routeTree.gen.ts` by the router plugin in `vite.config.ts`). The root
route (`routes/__root.tsx`) is the page: with a patient chosen, the patient
line and the chunk bar over `react-tundraish`'s `RouteTabs`, each tab a child
route over the same loaded `MedicationRequest`s, in its own folder with the
files only it uses:

- **Medications** (`/medications`) — `medication-sponsorship-react`'s list
  with sponsorship chips, growing a page at a time as its end scrolls into
  view.
- **Calendar** (`/calendar`) — `medication-calendar-react`'s prescription
  calendar.
- **Interactions** (`/interactions`) — `medication-interaction-react`'s
  three-group report over the current (active, deduplicated) medications,
  checked against the bundled DDInter catalog. Opening it, by its tab or a
  link, reads every remaining page and starts the catalog's download
  alongside the list's first page: the report waits behind a gate for the
  full list, unless the reader asks to see it as pages arrive.
- **Savings** (`/savings`) — `medication-sponsorship-react`'s savings-program
  breakdown of the same current medications, with the province picker.

`/` redirects to `/medications`, replacing itself in history. A path no tab
names (a stale bookmark, `/index.html`) shows a not-found card in the tab
panel, offering the Medications tab. Calendar and Savings render from the
pages loaded so far, under a banner offering to load the rest. Every route
reads the read through `routes/-medication-read.ts`, one query on the page's
cache whose landed requests are converted to views once per page, and the
reader's choices that span tabs (the load-everything request, the
interactions gate's escape, the province) from the page store in the router
context (`src/page-state.ts`, a `react-kitchen-sink` subscribable store).

### The router and the OAuth callback

The history, the basepath, and building the router only once the SMART
handshake has completed are `smart-app-react`'s; the ordering rules are its
[Routing a SMART app](../../../slices/smart-app-react/AGENTS.md#routing-a-smart-app).
`<App />` builds the router under its `SmartHandshakeGate`, once, for the
visit, with a context fixed for it: the page's query cache, the one client
the handshake hands out, and the page store. A deep link such as `/calendar`
(or `/pr-<n>/calendar` in a preview) is served by the 404 page's redirect to
the app root and restored there. The OAuth redirect URI is the app root,
where every launch starts, so a launch returns there, and the root opens
Medications.

### Bundled catalogs

`src/data/` holds the build-time data, each decoded once at module load:

- `innovicares.json` / `rxhelp.json` → `src/routes/savings/-catalogs.ts` (sponsor programs).
- `ddinter/ddinter.json` → `src/routes/interactions/-interaction-catalog.ts` (drug
  interactions).
  Regenerate it from DDInter's download CSVs
  (<https://ddinter.scbdd.com/download/>, `ddinter_downloads_code_<letter>.csv`)
  with

  ```bash
  vp run -F @wildflowerhealthio/medications-web data:ddinter -- <directory holding the CSVs>
  ```

  The script (`scripts/convert-ddinter.ts`) runs `node --conditions=source` so
  the core's converter resolves from source without a build; the file is
  single-line JSON and is excluded from `vp fmt` in the root `vite.config.ts`.
  See [apps/medications/AGENTS.md](../AGENTS.md)
  for the bundled data's provenance and coverage.

## Where the bundle is served

`vp build` writes this package's default `dist/`, and that build is served in
one place: **the published site**, at
<https://medications.wildflowerhealth.io/>.
`.github/workflows/deploy-pages-site.yml` publishes `dist/` to the root of the
`gh-pages` branch of `wildflowerhealthio/medications-web`, which Pages serves at
that origin ([apps/wildflower-site AGENTS.md](../../wildflower-site/AGENTS.md)), and
each pull request that changes it previews the same build under
`https://medications.wildflowerhealth.io/pr-<n>/`. This is the
**production** launch target: the `medications` registry row points at that
URL. Nothing ships on device — in development the
`medications-dev` row launches the vite dev server instead (below).

## Registration

The app row and its OAuth client are seeded by migrations that must stay in
lockstep — an app registration whose `client_id` has no registered client cannot
launch:

- `apps/host/wildflower-server/apps-rust/migrations/0003_seed_wildflower_medication_app/`,
  `0005_first_party_apps_to_cloud/` and `0019_rekey_site_apps/`, which gives the
  row its tile id `medications`
- `apps/host/wildflower-server/authorization-server-rust/migrations/0004_seed_wildflower_medication_client/`,
  `0006_rename_first_party_app_clients/` and `0028_rekey_site_app_clients/`,
  which gives the client its random id, `9769f8b274370708d0d3ebb2e3e59b7c`

`src/config.ts`'s `clientId` must equal the `client_id` of the app row it is
launched through, for both the production and the dev registration: a launch
checks the caller's grant against that client's scopes, and `/authorize` matches
the redirect against that client's registered URIs.

Both launches request one scope string, `MEDICATIONS_SCOPE`:

```text
launch openid fhirUser system/MedicationRequest.rs system/Medication.rs system/Patient.rs
```

`system/` scopes only, with no `launch/patient`: the patient is picked in the
app, so the authorization server binds none to the token. `system/Patient.rs`
reads the patients the picker lists and the one named under the H1. The
production client (its scopes as the authorization server migration
`0020_first_party_apps_pick_the_patient` left them) and the debug-only
`medications-dev` tile's client (`seed_dev_app_clients` in
`authorization-server-rust/src/seeding.rs`) allow exactly this set; a test there reads
`src/config.ts` and pins both clients to it.

## Running the dev server

```bash
vp run -F @wildflowerhealthio/medications-web dev     # strictPort, from dev-app-ports.json
```

Debug builds of the host additionally seed a `medications-dev`
row on that port plus its own OAuth client (`apps-rust`'s `seed_dev_apps` /
`authorization-server-rust`'s `seed_dev_app_clients`), so the homescreen carries a
"Medications (Dev)" tile that launches whatever is serving that port — the vite
dev server when it is up, nothing when it is down (there is no fallback build).
The port has a single source, `dev-app-ports.json`: `vite.config.ts`
reads it through the shared `devAppServer` helper in the root
`vite.config.base.ts` and `apps-rust` embeds it, so the dev server and the row
cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`medications-dev` id, the seed logs a warning and leaves it untouched rather
than adopting it — you get no dev tile until that app is renamed.

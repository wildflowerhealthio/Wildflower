# health-viewer-app

The first-party Synthesized Health Viewer SMART-on-FHIR app: a patient's
Observations and prescribed medication doses on one time axis, with up to four
value axes, so a dose change can be read against the numbers it is meant to
move. One HTML entry, `index.html`: the app root, which starts a SMART launch
its URL carries (an EHR's `iss` and `launch`, or a lone `iss`), completes the
handshake and renders the app when a callback is in the URL, and shows the
standalone connect menu, where the user picks a FHIR server, on a bare visit.

The chart, the series panel, the range presets and the page layout are
[`health-viewer-react`](../../slices/health-viewer/health-viewer-react/AGENTS.md)'s;
reading a record into series, the catalogue, the range presets and the URL codec
are [`health-viewer-core`](../../slices/health-viewer/health-viewer-core/AGENTS.md)'s.
This package is the SMART shell around them and the wiring between them.

## Boot structure

The entry runs on `smart-app-react`, the chrome every first-party SMART app
boots through (see [slices/smart-app/AGENTS.md](../../slices/smart-app/AGENTS.md)),
exactly as `apps/medications-app` does.

`src/main.tsx` is the `index.html` entry: it imports the design-system
stylesheet module (`react-tundraish/styles`), completes a GitHub Pages 404
redirect, wires the OS colour-scheme listener, and renders `<AppRoot />` inside
`<StrictMode>`.

`src/app-root.tsx` exports `AppRoot`: `<SmartAppRoot app="healthViewer"
registration={smartRegistration} telemetry={smartAppTelemetry}>` around
`<App />`. `SmartAppRoot` shows the telemetry consent dialog first, then
starts a launch the URL carries under a loading line or renders one of the
other two branches (`smartAppTelemetry` in `src/config.ts` names the app's Sentry project
through the `VITE_SENTRY_DSN_HEALTH_VIEWER` build variable; see
`.env.example`), owns the single `QueryClientProvider`, and branches, latched on mount, on whether a SMART
callback is in the URL — the slim `BrandBar` above `<App />` when launched, the
full Wildflower chrome with `APP_DESCRIPTIONS.healthViewer`'s `AppLanding`
beside `ConnectMenu` on a bare visit. The package exports `AppRoot` via the
`source` condition for future aggregator-shell composition.

## The page

The page is three steps, one component or hook each: settle on a patient, read
their record, lay it out.

- **Patient** (`src/app.tsx`'s `App`, over `smart-app-react`'s
  `usePatientChoice`). The URL's `?patient=`, else the launch's
  `client.patient.id`. With neither, the page is `smart-app-react`'s
  `PatientPicker` ("All patients" first, then name and birth date per row from
  `fetchPatientPage`, a "More patients" button while the server has more);
  choosing writes `?patient=<id>`, or `?patient=*` for All patients, to the
  URL. All patients reads every patient's Observations and MedicationRequests
  unscoped and charts them together. Under the title, `PatientChoiceLine`
  names the choice — `Name · born YYYY-MM-DD` from one `fetchPatient` read, or
  "All patients" — with a "Change patient" link back to the picker.
- **Record read** (`src/use-record-read.ts`'s `useRecordRead`). One
  `useInfiniteQuery` per record source, scoped to the patient (`null` for All
  patients) — `fetchObservationPage` and `fetchMedicationRequestPage`
  (MedicationRequests decode with a required `id`) — each drained to its last
  page by `react-kitchen-sink`'s `useFetchEveryPage`, so the sources page
  concurrently and the chart re-renders as pages arrive. There is no scroll sentinel. Each read's
  `pagedQueryStatusOf` is folded into one `RecordRead` — `loading`, `failed`
  (a first page failed) or `read` — with `readRecord` over what has landed,
  whether the record is complete, whether more is loading, which reads a later
  page halted, and what the chart leaves out.
- **Layout** (`src/patient-record.tsx`). `groupForPanel` lays the series out
  for `SeriesPanel` (observation categories first, Medications last); the
  selected series, in selection order, go through `ValueAxis.assign` to
  `MultiAxisChart`, over `xDomain(range, now, Series.extentOfAll(selected))`.
- **URL state** (`src/use-url-selection.ts`). The selection and the range
  live only in the URL, beside `usePatientChoice`'s `?patient=`: read once
  with `decodeSelection`, written back with `withSelection` (which keeps every
  other key) through `history.replaceState` after every change. Every change
  is an updater over the latest selection, so two made in one tick both land.
  Once every read has its last page, selected ids with no series in this
  record are dropped from the selection and the URL.
- **Status**, in `smart-app-react`'s read-status lines, shared with the
  medications app: `Loading…` until every read has its first page;
  `Loading more…` in the layout's status slot while any still pages; a failed
  later page is an inline `Could not load …` line that keeps every series
  already listed; a failed handshake or first page replaces the body.
- **What the chart left out**, under it: `n undated records skipped` and
  `n records couldn't be read` — the latter counts both what the sources could
  not read and page entries that did not decode (a MedicationRequest without an
  `id` among them).

### Adding a record source

When `health-viewer-core` adds a source to `SERIES_SOURCES` and
`RecordResources`, `useRecordRead` stops compiling until the source's read is
wired: a `RecordSourceRead` (its query name, its status-line subject, and how
to fetch a page from the patient scope or a `next` link), its line in
`sourceReadings`, and its resources in the `readRecord` call. Status,
completeness, failures and the left-out counts are folded over every source
alike; the page components do not change.

## Where the bundle is served

`vp build` writes this package's default `dist/`, and that build is served in
one place: **the published site**, at
[`/health-viewer-app`](https://wildflowerhealth.io/health-viewer-app/).
`github-pages` copies `dist/` into the Pages artifact
([../github-pages/README.md](../github-pages/README.md)), and each pull request's
`pr-preview.yml` build publishes the same tree under
`https://wildflowerhealthio.github.io/staging/pr-<n>/health-viewer-app/`.
The published page launches standalone against any SMART server, such as the
[SMART Health IT sandbox](https://launch.smarthealthit.org/). Nothing ships on
device.

## Registration

`src/config.ts`'s `clientId` is `health-viewer-app` in a production build and
`health-viewer-app-dev` under the vite dev server, and must equal the
`client_id` of the app row it is launched through — a launch checks the
caller's grant against that client's scopes, and `/authorize` matches the
redirect against that client's registered URIs — and its scope string must
equal the client's allowed scopes; `gatekeeper-rust`'s `seeding.rs` test reads
`config.ts` to hold both clients to it.

- **`health-viewer-app`** is a row (apps migration
  `0015_seed_health_viewer_app`, its URL as
  `0016_launch_first_party_apps_at_root` left it) launching
  `https://wildflowerhealth.io/health-viewer-app/?launch={launch}&iss={origin}/fhir-r4`
  with `requires_tunnel` set, as every first-party row has. Its public OAuth
  client (gatekeeper migration `0022_seed_health_viewer_app_client`) redirects
  to `https://wildflowerhealth.io/health-viewer-app/`.
- **`health-viewer-app-dev`** is seeded in debug builds only, at runtime rather
  than by a migration: a row on the dev server's port
  (`apps-rust/src/dev_seed.rs`) and its client, redirecting to
  `http://localhost:<port>/` (`gatekeeper-rust/src/seeding.rs`).

## Running locally

```bash
vp run -F health-viewer-app dev     # strictPort, from slices/apps/dev-app-ports.json
```

**Standalone**: open the printed `http://localhost:<port>/`, pick a server on the
connect menu (the SMART Health IT sandbox works), sign in, and choose a patient
(or All patients) in the app.

**From a Wildflower host**: debug builds of the host seed a
`health-viewer-app-dev` row on that port plus its own OAuth client
(`apps-rust`'s `seed_dev_apps` / `gatekeeper-rust`'s `seed_dev_app_clients`),
so the homescreen carries a "Health Viewer (Dev)" tile that launches whatever is
serving that port — the vite dev server when it is up, nothing when it is down.
A launch with a patient in context opens on that patient. The port has a
single source, `slices/apps/dev-app-ports.json`: `vite.config.ts` reads it through the shared
`devAppServer` helper in the root `vite.config.base.ts` and `apps-rust` embeds
it, so the dev server and the row cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`health-viewer-app-dev` id, the seed logs a warning and leaves it untouched
rather than adopting it — you get no dev tile until that app is renamed.

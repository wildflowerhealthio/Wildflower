# health-viewer-app

The first-party Synthesized Health Viewer SMART-on-FHIR app: a patient's
Observations and prescribed medication doses on one time axis, with up to four
value axes, so a dose change can be read against the numbers it is meant to
move. Two HTML entries, `launch.html` (the EHR launch endpoint that starts the
OAuth2 authorize redirect) and `index.html` (the app root — the redirect target
that completes the handshake and renders the app when a callback is in the URL,
and the standalone connect menu, where the user picks a FHIR server, on a bare
visit).

The chart, the series panel, the range presets and the page layout are
[`health-viewer-react`](../../slices/health-viewer/health-viewer-react/AGENTS.md)'s;
reading a record into series, the catalogue, the range presets and the URL codec
are [`health-viewer-core`](../../slices/health-viewer/health-viewer-core/AGENTS.md)'s.
This package is the SMART shell around them and the wiring between them.

## Boot structure

Both entries run on `smart-app-react`, the chrome every self-hosted SMART app
boots through (see [slices/smart-app/AGENTS.md](../../slices/smart-app/AGENTS.md)),
exactly as `apps/medications-app` does.

`src/main.tsx` is the `index.html` entry: it imports the design-system
stylesheet module (`react-tundraish/styles`), completes a GitHub Pages 404
redirect, wires the OS colour-scheme listener, and renders `<AppRoot />` inside
`<StrictMode>`.

`src/app-root.tsx` exports `AppRoot`: `<SmartAppRoot app="healthViewer"
standalone={standaloneSmartConfig}>` around `<App />`. `SmartAppRoot` owns the
single `QueryClientProvider` and branches, latched on mount, on whether a SMART
callback is in the URL — the slim `BrandBar` above `<App />` when launched, the
full Wildflower chrome with `APP_DESCRIPTIONS.healthViewer`'s `AppLanding`
beside `ConnectMenu` on a bare visit. The package exports `AppRoot` via the
`source` condition for future aggregator-shell composition.

`src/launch-main.tsx` is the `launch.html` entry: the same stylesheet import,
then one `runSmartLaunchEntry({ launch: smartConfig, loadingMessage })` call.

## The page

`src/app.tsx`'s `App`:

- **Patient.** The launch's `client.patient.id`, else the URL's `?patient=`.
  With neither, the page is a patient picker (`src/patient-picker.tsx`,
  `fetchPatientPage`: name and birth date per row); choosing one writes
  `?patient=` to the URL. The title's subtitle is the patient from one
  `fetchPatient` read, as `Name · born YYYY-MM-DD`.
- **Loading.** Two `useInfiniteQuery`s side by side — `fetchObservationPage`
  and `fetchMedicationRequestPage` (MedicationRequests decode with a required
  `id`) — each drained by an effect that requests the next page until the last
  one lands, so both kinds page concurrently and the chart re-renders as pages
  arrive. There is no scroll sentinel.
- **Reading.** `readRecord` turns what has landed into series; `groupForPanel`
  lays them out for `SeriesPanel` (observation categories first, Medications
  last); the selected series, in selection order, go through `ValueAxis.assign`
  to `MultiAxisChart`, over `xDomain(range, now, Series.extentOfAll(selected))`.
- **URL state** (`src/use-url-selection.ts`). The selection, the range and
  the patient live only in the URL: read once with `decodeSelection`, written
  back with `encodeSelection` through `history.replaceState` after every
  change. Every change is an updater over the latest selection, so two made
  in one tick both land. Once both reads have finished paging,
  selected ids with no series in this record are dropped from the selection and
  the URL.
- **Status**, in the medications app's vocabulary: `Loading…` until the first
  page of each read has landed; `Loading more…` in the layout's status slot
  while either still pages; a failed later page of either is an inline
  `Could not load …` line that keeps every series already listed; a failed
  handshake or first page replaces the body.
- **What the chart left out**, under it: `n undated records skipped` and
  `n records couldn't be read` — the latter counts both what the sources could
  not read and page entries that did not decode (a MedicationRequest without an
  `id` among them).

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

The production `health-viewer-app` registry row and OAuth client are not
seeded yet (#588). In development the debug-only `health-viewer-app-dev` row
launches the vite dev server instead (below).

`src/config.ts`'s `clientId` must equal the app id it is launched through — the
host's redirect resolver looks an app up by `client_id` — and its scope string
must equal the seeded client's allowed scopes; `gatekeeper-rust`'s
`seeding.rs` test reads `config.ts` to hold the dev client to it.

## Running locally

```bash
vp run -F health-viewer-app dev     # strictPort, from slices/apps/dev-app-ports.json
```

**Standalone**: open the printed `http://localhost:<port>/`, pick a server on the
connect menu (the SMART Health IT sandbox works), and choose a patient there.

**From a Wildflower host**: debug builds of the host seed a
`health-viewer-app-dev` **cloud** row on that port plus its own OAuth client
(`apps-rust`'s `seed_dev_apps` / `gatekeeper-rust`'s `seed_dev_app_clients`),
so the homescreen carries a "Health Viewer (Dev)" tile that launches whatever is
serving that port with the host's patient in context — the vite dev server when
it is up, nothing when it is down. The port has a single source,
`slices/apps/dev-app-ports.json`: `vite.config.ts` reads it through the shared
`devAppServer` helper in the root `vite.config.base.ts` and `apps-rust` embeds
it, so the dev server and the row cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`health-viewer-app-dev` id, the seed logs a warning and leaves it untouched
rather than adopting it — you get no dev tile until that app is renamed.

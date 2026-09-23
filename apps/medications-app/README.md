# medications-app

The first-party Medications SMART-on-FHIR app: two HTML entries, `launch.html`
(the EHR launch endpoint that starts the OAuth2 authorize redirect) and
`index.html` (the app root — the redirect target that completes the handshake
and renders the app when a callback is in the URL, and the standalone connect
menu, where the user picks a FHIR server, on a bare visit).

## Boot structure

`src/main.tsx` is the HTML entry point: it loads style sheets (tundra-css,
react-tundraish, branding-react layout tokens, self-hosted fonts), wires the OS
colour-scheme listener, and renders `<AppRoot />` inside `<StrictMode>`.

`src/app-root.tsx` exports `AppRoot`, the top-level component that wraps
everything in a single `QueryClientProvider` and branches on whether a SMART
callback is in the URL:

- **Launched** (OAuth callback present) — renders `<BrandBar />` (a slim brand
  link back to the marketing site) above `<App />`.
- **Standalone** (bare visit) — renders the full Wildflower chrome:
  `<SiteHeader>`, `<ConnectMenu>`, `<SiteFooter>`, with nav links resolving as
  absolute URLs back to `wildflowerhealth.io`.

`AppRoot` accepts an optional `launched` prop (defaults to the live URL check)
so both branches are testable without URL manipulation. The package exports
`AppRoot` via the `source` condition for future aggregator-shell composition.

## Views

The header toggle switches `<App />` between two views over the same loaded
`MedicationRequest`s:

- **Medications** — `medication-sponsorship-react`'s list with sponsorship
  chips and the province picker (the picker only shows on this view).
- **Interactions** — `medication-interaction-react`'s three-group report over
  the _active_ medications, checked against the bundled DDInter catalog.

### Bundled catalogs

`src/data/` holds the build-time data, each decoded once at module load:

- `innovicares.json` / `rxhelp.json` → `src/catalogs.ts` (sponsor programs).
- `ddinter/ddinter.json` → `src/interaction-catalog.ts` (drug interactions).
  Regenerate it from DDInter's download CSVs
  (<https://ddinter.scbdd.com/download/>, `ddinter_downloads_code_<letter>.csv`)
  with

  ```bash
  vp run -F medications-app data:ddinter -- <directory holding the CSVs>
  ```

  The script (`scripts/convert-ddinter.ts`) runs `node --conditions=source` so
  the core's converter resolves from source without a build; the file is
  single-line JSON and is excluded from `vp fmt` in the root `vite.config.ts`.
  See [slices/medication/AGENTS.md](../../slices/medication/AGENTS.md)
  for the bundled data's provenance and coverage.

## Where the bundle is served

`vp build` writes this package's default `dist/`, and that build is served in
one place: **the published site**, at
[`/medications-app`](https://wildflowerhealth.io/medications-app).
`github-pages` copies `dist/` into the Pages artifact
([../github-pages/README.md](../github-pages/README.md)). This is the
**production** launch target: the `medications-app` registry row is a _cloud_ row
pointing at that URL. Nothing ships on device — in development the
`medications-app-dev` row launches the vite dev server instead (below).

## Registration

The app row and its OAuth client are seeded by migrations that must stay in
lockstep — an app registration whose `client_id` has no registered client cannot
launch:

- `slices/apps/apps-rust/migrations/0003_seed_wildflower_medication_app/` (the
  original self-hosted seed) and `0005_first_party_apps_to_cloud/` (the rename to
  `medications-app` + the flip to a cloud row served from the published site)
- `slices/gatekeeper/gatekeeper-rust/migrations/0004_seed_wildflower_medication_client/`
  and `0006_rename_first_party_app_clients/`

`src/config.ts`'s `clientId` must equal the app id it is launched through, for
both the production and the dev registration — the host's redirect resolver looks
an app up by `client_id`, so the app-relative redirect only resolves when the two
are equal.

## Running the dev server

```bash
vp run -F medications-app dev     # strictPort, from slices/apps/dev-app-ports.json
```

Debug builds of the host additionally seed a `medications-app-dev` **cloud**
row on that port plus its own OAuth client (`apps-rust`'s `seed_dev_apps` /
`gatekeeper-rust`'s `seed_dev_app_clients`), so the homescreen carries a
"Medications (Dev)" tile that launches whatever is serving that port — the vite
dev server when it is up, nothing when it is down (there is no fallback build).
The port has a single source, `slices/apps/dev-app-ports.json`: `vite.config.ts`
reads it through the shared `devAppServer` helper in the root
`vite.config.base.ts` and `apps-rust` embeds it, so the dev server and the row
cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`medications-app-dev` id, the seed logs a warning and leaves it untouched rather
than adopting it — you get no dev tile until that app is renamed.
